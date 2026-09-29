import { createPrivateKey, sign } from 'node:crypto';
import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Credentials for the direct APNs / FCM push adapters (architecture §Alerting: "Push uses
 * APNs/FCM directly"). Each lives in its own Secrets Manager secret, with a separate sandbox
 * secret for self-test and canary messages. Secret JSON shapes are documented in
 * infrastructure/components/alerting/channel-workers.ts.
 *
 * Every cache here is keyed by secret ID, never by platform alone: the prod and sandbox
 * credentials must never share a slot, or a self-test could reuse a cached prod token (or a
 * real page a sandbox one).
 */

export type PushPlatform = 'APNS' | 'FCM';

export type ApnsInterruptionLevel = 'critical' | 'time-sensitive';

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: string;
  readonly bundleId: string;
  readonly environment: 'production' | 'sandbox';
  readonly interruptionLevel: ApnsInterruptionLevel;
}

export interface FcmCredentials {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly privateKeyId?: string | undefined;
  /**
   * Interruption level for the `apns` block FCM carries to an iOS device still on a legacy FCM
   * token. An optional `apnsInterruptionLevel` key added to the service-account JSON, set the
   * same as the APNs secret's `interruptionLevel`; defaults to `critical`.
   */
  readonly apnsInterruptionLevel: ApnsInterruptionLevel;
}

const ENV_KEYS: Record<PushPlatform, { readonly prod: string; readonly sandbox: string }> = {
  APNS: { prod: 'APNS_SECRET_ID', sandbox: 'APNS_SANDBOX_SECRET_ID' },
  FCM: { prod: 'FCM_SECRET_ID', sandbox: 'FCM_SANDBOX_SECRET_ID' },
};

/**
 * `isTest` selects the sandbox secret and fails closed: a test message with no sandbox secret
 * configured throws rather than falling back to the prod credentials (architecture §1.3, the
 * same rule readChannelProviderConfig enforces for SMS/voice).
 */
export function readPushSecretId(
  platform: PushPlatform,
  env: NodeJS.ProcessEnv,
  options: { readonly isTest?: boolean } = {},
): string {
  const key = options.isTest ? ENV_KEYS[platform].sandbox : ENV_KEYS[platform].prod;
  const secretId = env[key];
  if (!secretId) {
    throw new Error(`${key} is required and was not set`);
  }
  return secretId;
}

const SECRET_CACHE_TTL_MS = 15 * 60 * 1000;

interface CachedSecret {
  readonly value: Record<string, unknown>;
  readonly expiresAt: number;
}

const secretCache = new Map<string, CachedSecret>();

async function readSecretJson(
  secretId: string,
  client: SecretsManagerClient,
): Promise<Record<string, unknown>> {
  const cached = secretCache.get(secretId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const output = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!output.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString value`);
  }
  let value: unknown;
  try {
    value = JSON.parse(output.SecretString);
  } catch {
    // Never echo the secret body into the error.
    throw new Error(`Secret ${secretId} is not valid JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Secret ${secretId} is not a JSON object`);
  }
  const record = value as Record<string, unknown>;
  secretCache.set(secretId, { value: record, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  return record;
}

function requireString(secret: Record<string, unknown>, field: string, secretId: string): string {
  const value = secret[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Secret ${secretId} is missing required field ${field}`);
  }
  return value;
}

/**
 * A sandbox secret always targets the APNs sandbox host; one that declares
 * `environment: "production"` is a misconfiguration and is refused, so a self-test can never
 * reach the production gateway.
 */
export async function loadApnsCredentials(
  secretId: string,
  client: SecretsManagerClient,
  options: { readonly isTest?: boolean } = {},
): Promise<ApnsCredentials> {
  const secret = await readSecretJson(secretId, client);
  const declared = secret.environment;
  if (declared !== undefined && declared !== 'production' && declared !== 'sandbox') {
    throw new Error(`Secret ${secretId} environment must be "production" or "sandbox"`);
  }
  if (options.isTest && declared === 'production') {
    throw new Error(`Sandbox secret ${secretId} declares environment "production"; refusing`);
  }
  const level = secret.interruptionLevel;
  if (level !== undefined && level !== 'critical' && level !== 'time-sensitive') {
    throw new Error(`Secret ${secretId} interruptionLevel must be "critical" or "time-sensitive"`);
  }
  return {
    teamId: requireString(secret, 'teamId', secretId),
    keyId: requireString(secret, 'keyId', secretId),
    privateKey: requireString(secret, 'privateKey', secretId),
    bundleId: requireString(secret, 'bundleId', secretId),
    environment: options.isTest ? 'sandbox' : (declared ?? 'production'),
    interruptionLevel: level ?? 'critical',
  };
}

/** The Firebase service-account JSON exactly as the Firebase console downloads it. */
export async function loadFcmCredentials(
  secretId: string,
  client: SecretsManagerClient,
): Promise<FcmCredentials> {
  const secret = await readSecretJson(secretId, client);
  const privateKeyId = secret.private_key_id;
  const level = secret.apnsInterruptionLevel;
  if (level !== undefined && level !== 'critical' && level !== 'time-sensitive') {
    throw new Error(
      `Secret ${secretId} apnsInterruptionLevel must be "critical" or "time-sensitive"`,
    );
  }
  return {
    apnsInterruptionLevel: level ?? 'critical',
    projectId: requireString(secret, 'project_id', secretId),
    clientEmail: requireString(secret, 'client_email', secretId),
    privateKey: requireString(secret, 'private_key', secretId),
    privateKeyId: typeof privateKeyId === 'string' ? privateKeyId : undefined,
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKeyPem: string,
  algorithm: 'ES256' | 'RS256',
): string {
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(
    'sha256',
    Buffer.from(signingInput),
    // JWS ES256 wants the raw r||s form, not DER.
    algorithm === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
  );
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * APNs rejects a provider token older than 60 minutes (ExpiredProviderToken) and throttles
 * one refreshed more than once per 20 (TooManyProviderTokenUpdates); 50 minutes sits between.
 */
export const APNS_JWT_MAX_AGE_MS = 50 * 60 * 1000;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

const apnsJwtCache = new Map<string, CachedToken>();

export function apnsProviderToken(
  secretId: string,
  credentials: ApnsCredentials,
  now: number = Date.now(),
): string {
  const cacheKey = `${secretId}#${credentials.keyId}`;
  const cached = apnsJwtCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.token;
  }
  const token = signJwt(
    { alg: 'ES256', kid: credentials.keyId },
    { iss: credentials.teamId, iat: Math.floor(now / 1000) },
    credentials.privateKey,
    'ES256',
  );
  apnsJwtCache.set(cacheKey, { token, expiresAt: now + APNS_JWT_MAX_AGE_MS });
  return token;
}

export const FCM_OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Google access tokens live 60 minutes; never hold one past 55. */
export const FCM_ACCESS_TOKEN_MAX_AGE_MS = 55 * 60 * 1000;
const FCM_ASSERTION_LIFETIME_SECONDS = 3600;

const fcmAccessTokenCache = new Map<string, CachedToken>();

export interface FcmAccessTokenOptions {
  readonly tokenUrl?: string;
  readonly timeoutMs: number;
  readonly now?: number;
}

/** OAuth 2.0 JWT-bearer grant (RFC 7523) with the service account's RS256 key. */
export async function fcmAccessToken(
  secretId: string,
  credentials: FcmCredentials,
  options: FcmAccessTokenOptions,
): Promise<string> {
  const now = options.now ?? Date.now();
  const cacheKey = `${secretId}#${credentials.clientEmail}`;
  const cached = fcmAccessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.token;
  }
  const tokenUrl = options.tokenUrl ?? GOOGLE_OAUTH_TOKEN_URL;
  const iat = Math.floor(now / 1000);
  const assertion = signJwt(
    {
      alg: 'RS256',
      typ: 'JWT',
      ...(credentials.privateKeyId ? { kid: credentials.privateKeyId } : {}),
    },
    {
      iss: credentials.clientEmail,
      scope: FCM_OAUTH_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat,
      exp: iat + FCM_ASSERTION_LIFETIME_SECONDS,
    },
    credentials.privateKey,
    'RS256',
  );
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) {
    const message = `FCM OAuth token endpoint responded ${response.status}`;
    // 400 invalid_grant / 401 invalid_client: the service-account key itself was refused.
    throw response.status === 400 || response.status === 401
      ? new PushProviderAuthError(message)
      : new Error(message);
  }
  const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error('FCM OAuth token endpoint returned no access_token');
  }
  const lifetimeMs =
    typeof body.expires_in === 'number' && body.expires_in > 0
      ? Math.min(body.expires_in * 1000 - 5 * 60 * 1000, FCM_ACCESS_TOKEN_MAX_AGE_MS)
      : FCM_ACCESS_TOKEN_MAX_AGE_MS;
  fcmAccessTokenCache.set(cacheKey, { token: body.access_token, expiresAt: now + lifetimeMs });
  return body.access_token;
}

/**
 * The gateway rejected our credentials (APNs InvalidProviderToken/ExpiredProviderToken, FCM
 * 401/403, or the Google token endpoint refusing the service account). The usual cause is a
 * rotated or revoked key, so dropping only the signed token is not enough: the cached secret
 * still holds the old key and would sign another bad token for up to the secret TTL. Evict
 * the secret and every token minted from it, so the next attempt reads the key afresh.
 */
export function evictPushCredentials(secretId: string): void {
  secretCache.delete(secretId);
  for (const cache of [apnsJwtCache, fcmAccessTokenCache]) {
    for (const key of cache.keys()) {
      if (key.startsWith(`${secretId}#`)) cache.delete(key);
    }
  }
}

/** A credential refusal — see evictPushCredentials. Retried once in-process with fresh keys. */
export class PushProviderAuthError extends Error {}

export function resetPushCredentialCaches(): void {
  secretCache.clear();
  apnsJwtCache.clear();
  fcmAccessTokenCache.clear();
}
