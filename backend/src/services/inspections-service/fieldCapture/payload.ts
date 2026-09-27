import { isSafeAssetFilename } from '../assetsSigner.js';
import {
  isNonEmptyString,
  isPkSafeString,
  validateViolation,
  type Violation,
} from '../inspectionRecord.js';

export class FieldCaptureValidationError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'FieldCaptureValidationError';
    this.detail = detail;
  }
}

export interface FieldCapturePayload {
  readonly occupancyId: string;
  readonly inspectionId: string;
  readonly idempotencyKey: string;
  readonly photoFilenames: readonly string[];
  readonly violations: readonly Violation[];
  readonly conductedAt?: string;
}

const MAX_PHOTOS = 20;

function isSafeFilenameArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PHOTOS &&
    value.every((entry) => typeof entry === 'string' && isSafeAssetFilename(entry))
  );
}

function isPathSafeId(value: unknown): value is string {
  return isPkSafeString(value) && isSafeAssetFilename(value);
}

// A capture is stamped by the phone and may sync much later from the offline outbox, so
// the phone's clock - not the server's - sets conductedAt. A phone running a little fast
// must not have its capture refused (a 400 is terminal in the outbox: the capture would be
// lost), so allow modest skew while still rejecting a genuinely future timestamp.
const CLOCK_SKEW_ALLOWANCE_MS = 5 * 60 * 1000;

function isPastOrPresentIsoDateTime(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && parsed <= Date.now() + CLOCK_SKEW_ALLOWANCE_MS;
}

export function parseFieldCapturePayload(body: unknown): FieldCapturePayload {
  if (typeof body !== 'object' || body === null) {
    throw new FieldCaptureValidationError('Request body must be a JSON object');
  }
  const { occupancyId, inspectionId, idempotencyKey, photoFilenames, violations, conductedAt } =
    body as Record<string, unknown>;

  if (!isPkSafeString(occupancyId)) {
    throw new FieldCaptureValidationError(
      "occupancyId is required and must be a non-empty string without '#'",
    );
  }
  if (!isPathSafeId(inspectionId)) {
    throw new FieldCaptureValidationError(
      'inspectionId is required and must be a non-empty, path-safe string (no #, /, or ..)',
    );
  }
  if (!isNonEmptyString(idempotencyKey) || idempotencyKey.includes('#')) {
    throw new FieldCaptureValidationError(
      "idempotencyKey is required and must be a non-empty string without '#'",
    );
  }

  const filenames = photoFilenames ?? [];
  if (!isSafeFilenameArray(filenames)) {
    throw new FieldCaptureValidationError(
      'photoFilenames must be an array of at most 20 safe filenames',
    );
  }

  const rawViolations = violations ?? [];
  if (!Array.isArray(rawViolations)) {
    throw new FieldCaptureValidationError('violations must be an array');
  }

  if (conductedAt !== undefined && !isPastOrPresentIsoDateTime(conductedAt)) {
    throw new FieldCaptureValidationError(
      'conductedAt must be a valid ISO date-time that is not in the future',
    );
  }

  return {
    occupancyId,
    inspectionId,
    idempotencyKey,
    photoFilenames: filenames,
    violations: rawViolations.map((entry, index) => validateViolation(entry, index)),
    ...(conductedAt !== undefined && { conductedAt }),
  };
}
