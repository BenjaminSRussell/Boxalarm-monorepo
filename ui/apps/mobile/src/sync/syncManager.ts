import NetInfo from '@react-native-community/netinfo';
import { ApiError, apiRequest, type AuthTokenSource } from '../lib/apiClient';
import type { SyncQueueStatus } from '../features/sync/types';
import * as outbox from './outbox';
import type { OutboxKind, OutboxRow } from './outbox';

type Listener = (status: SyncQueueStatus) => void;

let tokens: AuthTokenSource | null = null;
let apiBaseUrl: string | null = null;
let draining = false;
// Set when drain() is called while one is already running, so the running drain loops once more
// instead of silently skipping an entry enqueued after it listed the outbox.
let drainRequested = false;
let unsubscribeNetInfo: (() => void) | null = null;
// Set once the startup reconciliation of stranded SYNCING rows has run for this process.
let recoveredOrphans = false;
let lastSyncAt: string | null = null;
const listeners = new Set<Listener>();

// Called on every auth/config change (useSyncEngine, mounted once at the app root). While signed in, a NetInfo
// listener drains on reconnect; on sign-out it is removed so repeated login/logout cycles never
// stack listeners. Entries queued while signed out are drained as soon as tokens arrive.
export function configure(nextTokens: AuthTokenSource | null, nextApiBaseUrl: string | null): void {
  tokens = nextTokens;
  apiBaseUrl = nextApiBaseUrl;
  if (tokens && apiBaseUrl) {
    unsubscribeNetInfo ??= NetInfo.addEventListener((state) => {
      if (state.isConnected === true) void drain();
    });
    void drain();
  } else if (unsubscribeNetInfo) {
    unsubscribeNetInfo();
    unsubscribeNetInfo = null;
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  void notify();
  return () => {
    listeners.delete(listener);
  };
}

async function notify(): Promise<void> {
  const status = await outbox.getStatus(lastSyncAt);
  listeners.forEach((listener) => listener(status));
}

function unitPath(unitId: string, suffix: string): string {
  return `apparatus/${encodeURIComponent(unitId)}/${suffix}`;
}

async function enqueueAndDrain(
  kind: OutboxKind,
  id: string,
  label: string,
  path: string,
  body: Record<string, unknown>,
  photoLocalUri?: string,
): Promise<void> {
  await outbox.enqueue({ id, kind, label, path, body, photoLocalUri });
  await notify();
  void drain();
}

export async function enqueueChecklistRun(
  unitId: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
): Promise<void> {
  await enqueueAndDrain(
    'CHECKLIST_RUN',
    idempotencyKey,
    `Truck check — ${unitId}`,
    unitPath(unitId, 'checks'),
    body,
  );
}

export async function enqueueDefect(
  unitId: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
  photoLocalUri?: string,
): Promise<void> {
  await enqueueAndDrain(
    'DEFECT',
    idempotencyKey,
    `Defect report — ${unitId}`,
    unitPath(unitId, 'defects'),
    body,
    photoLocalUri,
  );
}

// POST /api/v1/inspections/field-capture (inspections-service fieldCapture/handler.ts). The body
// carries its own idempotencyKey, so a replay after a lost response is answered 200 "duplicate"
// with the original inspection and freshly signed photo upload URLs.
export async function enqueueFieldCapture(
  idempotencyKey: string,
  occupancyId: string,
  body: Record<string, unknown>,
  photoLocalUri?: string,
): Promise<void> {
  await enqueueAndDrain(
    'FIELD_CAPTURE',
    idempotencyKey,
    `Field capture — ${occupancyId}`,
    'inspections/field-capture',
    body,
    photoLocalUri,
  );
}

export async function retry(id: string): Promise<void> {
  await outbox.retry(id);
  await notify();
  void drain();
}

export async function discard(id: string): Promise<void> {
  await outbox.discard(id);
  await notify();
}

// A signed photo URL is short-lived (an S3 presigned PUT, 10 min). The defect API has no way to
// re-issue one: an idempotent replay of the POST returns the existing defect without an
// uploadUrl, so an expired defect URL can never succeed - the defect itself is saved, only its
// photo is lost - and is surfaced to the user instead of retried forever. Field capture differs:
// its replay re-signs the upload URLs (RESIGNS_ON_REPLAY), so an expired link is recoverable.
const RESIGNS_ON_REPLAY: ReadonlySet<OutboxKind> = new Set(['FIELD_CAPTURE']);

class PhotoUploadUrlExpiredError extends Error {
  constructor(kind: OutboxKind) {
    super(
      RESIGNS_ON_REPLAY.has(kind)
        ? 'Photo upload was refused - retry to request a new upload link'
        : 'Photo upload link expired - the defect was reported without its photo',
    );
  }
}

function isExpired(url: string): boolean {
  const expiresAtMs = signedUrlExpiresAtMs(url);
  return expiresAtMs !== null && Date.now() >= expiresAtMs;
}

// S3 SigV4 presigned URLs carry X-Amz-Date (YYYYMMDDTHHMMSSZ) and X-Amz-Expires (seconds).
export function signedUrlExpiresAtMs(url: string): number | null {
  const date = /[?&]X-Amz-Date=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(url);
  const expires = /[?&]X-Amz-Expires=(\d+)/.exec(url);
  if (!date || !expires) return null;
  const [, y, mo, d, h, mi, sec] = date.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, sec!) + Number(expires[1]) * 1000;
}

// A 4xx means the server refused this request as sent, so an identical retry cannot succeed -
// except 408 (timeout) and 429 (throttled), which are transient. 401 never reaches here as
// permanent in practice: apiRequest already renewed the token once, and a still-expired session
// is recoverable by signing in again, so it is treated as transient too.
function isPermanentRejection(error: unknown): boolean {
  if (error instanceof PhotoUploadUrlExpiredError) return true;
  if (!(error instanceof ApiError)) return false;
  const { status } = error.problem;
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return error instanceof Error ? error.message : String(error);
}

function guessPhotoContentType(uri: string): string {
  const extension = uri.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

async function uploadPhoto(row: OutboxRow): Promise<void> {
  if (!row.photoLocalUri || !row.photoUploadUrl) return;
  if (isExpired(row.photoUploadUrl)) throw new PhotoUploadUrlExpiredError(row.kind);
  const fileResponse = await fetch(row.photoLocalUri);
  const blob = await fileResponse.blob();
  const uploadResponse = await fetch(row.photoUploadUrl, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': guessPhotoContentType(row.photoLocalUri) },
  });
  // S3 answers an expired or otherwise invalid signature with 403.
  if (uploadResponse.status === 403) throw new PhotoUploadUrlExpiredError(row.kind);
  if (!uploadResponse.ok) {
    throw new Error(`Photo upload failed with status ${uploadResponse.status}`);
  }
}

interface UploadTarget {
  readonly uploadUrl: string | null;
  readonly photoS3Key: string | null;
}

// Each create endpoint names its photo upload URL differently: the defect POST returns a single
// { uploadUrl, photoS3Key }; field capture returns photoUploadUrls: [{ filename, uploadUrl }] for
// the photoFilenames it was sent (the outbox row carries one photo, the first filename).
function readUploadTarget(row: OutboxRow, parsed: Record<string, unknown>): UploadTarget {
  if (row.kind === 'FIELD_CAPTURE') {
    const sent = (JSON.parse(row.body) as { photoFilenames?: string[] }).photoFilenames?.[0];
    const urls = Array.isArray(parsed.photoUploadUrls)
      ? (parsed.photoUploadUrls as { filename?: unknown; uploadUrl?: unknown }[])
      : [];
    const match = urls.find((entry) => entry.filename === sent);
    const inspection = parsed.inspection as { photoS3Keys?: unknown } | undefined;
    const keys = Array.isArray(inspection?.photoS3Keys) ? (inspection.photoS3Keys as string[]) : [];
    return {
      uploadUrl: typeof match?.uploadUrl === 'string' ? match.uploadUrl : null,
      photoS3Key: (sent && keys.find((key) => key.endsWith(`/${sent}`))) || null,
    };
  }
  return {
    uploadUrl: typeof parsed.uploadUrl === 'string' ? parsed.uploadUrl : null,
    photoS3Key: typeof parsed.photoS3Key === 'string' ? parsed.photoS3Key : null,
  };
}

async function create(row: OutboxRow): Promise<OutboxRow | undefined> {
  if (!tokens || !apiBaseUrl) throw new Error('Sync is not configured yet');
  const response = await apiRequest(row.path, tokens, {
    apiBaseUrl,
    method: row.method,
    headers: { 'Content-Type': 'application/json' },
    body: row.body,
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const target = readUploadTarget(row, parsed);
  await outbox.advanceStage(row.id, {
    stage: target.uploadUrl && row.photoLocalUri ? 'UPLOAD_PHOTO' : 'DONE',
    photoUploadUrl: target.uploadUrl,
    photoS3Key: target.photoS3Key,
  });
  return outbox.find(row.id);
}

async function processEntry(id: string): Promise<void> {
  let row = await outbox.find(id);
  if (!row) return;

  if (row.stage === 'CREATE') {
    row = await create(row);
    if (!row) return;
  }

  if (row.stage === 'UPLOAD_PHOTO') {
    // A kind whose replay re-signs gets a fresh link instead of a doomed PUT. The replay is safe:
    // the body's idempotencyKey makes the server answer "duplicate" without writing twice.
    if (row.photoUploadUrl && isExpired(row.photoUploadUrl) && RESIGNS_ON_REPLAY.has(row.kind)) {
      row = await create(row);
      if (!row || row.stage !== 'UPLOAD_PHOTO') return;
    }
    try {
      await uploadPhoto(row);
    } catch (error) {
      // Rewind to CREATE so the user's Retry replays the POST and fetches a new signed link.
      if (error instanceof PhotoUploadUrlExpiredError && RESIGNS_ON_REPLAY.has(row.kind)) {
        await outbox.advanceStage(row.id, { stage: 'CREATE', photoUploadUrl: null });
      }
      throw error;
    }
    await outbox.advanceStage(row.id, { stage: 'DONE' });
  }
}

export async function drain(): Promise<void> {
  if (!tokens || !apiBaseUrl) return;
  if (draining) {
    drainRequested = true;
    return;
  }
  draining = true;
  drainRequested = false;
  try {
    // Runs inside the draining lock so no row of this process can be genuinely mid-sync.
    if (!recoveredOrphans) {
      await outbox.recoverOrphanedSyncing();
      recoveredOrphans = true;
    }
    const netState = await NetInfo.fetch();
    if (netState.isConnected !== true) return;

    const pending = await outbox.listDrainable(Date.now());
    for (const row of pending) {
      await outbox.markSyncing(row.id);
      await notify();
      try {
        await processEntry(row.id);
        await outbox.markSynced(row.id);
        lastSyncAt = new Date().toISOString();
      } catch (error) {
        if (isPermanentRejection(error)) {
          await outbox.markRejected(row.id, describeError(error));
        } else {
          await outbox.markFailed(row.id, describeError(error));
        }
      }
      await notify();
    }
  } finally {
    draining = false;
  }
  if (drainRequested) void drain();
}
