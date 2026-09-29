import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import {
  constants,
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  APNS_SESSION_MAX_IDLE_MS,
  http2Transport,
  isConnectionLevelError,
  resetApnsSessions,
  sendViaApns,
  type Http2Transport,
} from './apnsAdapter.js';
import { resetPushCredentialCaches } from './pushCredentials.js';
import { PUSH_TTL_SECONDS, type PushNotification } from './pushPayload.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TOKEN = 'a'.repeat(64);

function apnsSecret(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    teamId: 'TEAM123456',
    keyId: 'KEY1234567',
    privateKey: P8,
    bundleId: 'org.nicholsfd.boxalarm',
    ...overrides,
  });
}

function secretsClient(secretString: string): {
  client: SecretsManagerClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ SecretString: secretString });
  return { client: { send } as unknown as SecretsManagerClient, send };
}

const dispatch: PushNotification = {
  token: TOKEN,
  alertKind: 'dispatch',
  dispatchId: 'NICHOLS-MANUAL-1798000000-abcd1234',
  toneSequence: 2,
  title: 'STRUCTURE_FIRE',
  body: 'STRUCTURE_FIRE — 123 Main St',
  idempotencyKey: 'NICHOLS-MANUAL-1798000000-abcd1234#2#mbr-1#PUSH',
  collapseKey: 'NICHOLS-MANUAL-1798000000-abcd1234#2',
};

function decodeJwt(jwt: string, key: KeyObject) {
  const [header, claims, signature] = jwt.split('.') as [string, string, string];
  const valid = verify(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>,
    valid,
  };
}

interface Captured {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A real HTTP/2 (h2c) server standing in for api.push.apple.com. */
describe('sendViaApns over a local HTTP/2 server', () => {
  let server: Http2Server;
  let origin: string;
  const captured: Captured[] = [];
  let reply: { status: number; body?: string } = { status: 200 };
  /** One-shot replies consumed before `reply`, for in-process retry sequences. */
  const replyQueue: { status: number; body?: string }[] = [];

  beforeAll(async () => {
    server = createServer();
    server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        captured.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
        const next = replyQueue.shift() ?? reply;
        if (next.status === 0) return; // never answer: exercise the timeout
        stream.respond({ ':status': next.status, 'apns-id': String(headers['apns-id']) });
        stream.end(next.body ?? '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    resetApnsSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    captured.length = 0;
    reply = { status: 200 };
    replyQueue.length = 0;
    resetPushCredentialCaches();
  });

  const send = (secret = apnsSecret(), notification = dispatch, extra = {}) =>
    sendViaApns(notification, {
      secretId: 'apns-prod',
      isTest: false,
      secretsClient: secretsClient(secret).client,
      timeoutMs: 4_000,
      origin,
      ...extra,
    });

  it('sends a critical alert with the APNs headers, a per-tone collapse id and a valid ES256 provider token', async () => {
    const result = await send();

    expect(result.outcome).toBe('sent');
    const [request] = captured;
    expect(request?.headers[':method']).toBe('POST');
    expect(request?.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(request?.headers['apns-topic']).toBe('org.nicholsfd.boxalarm');
    expect(request?.headers['apns-push-type']).toBe('alert');
    expect(request?.headers['apns-priority']).toBe('10');
    // Bounded expiry: an offline phone must not ring hours later for a finished call.
    const expiration = Number(request?.headers['apns-expiration']);
    expect(expiration - Date.now() / 1000).toBeGreaterThan(PUSH_TTL_SECONDS - 5);
    expect(expiration - Date.now() / 1000).toBeLessThanOrEqual(PUSH_TTL_SECONDS);
    expect(request?.headers['apns-collapse-id']).toBe('NICHOLS-MANUAL-1798000000-abcd1234#2');
    expect(request?.headers['apns-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const authorization = String(request?.headers.authorization);
    expect(authorization.startsWith('bearer ')).toBe(true);
    const jwt = decodeJwt(authorization.slice('bearer '.length), publicKey);
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(jwt.claims.iss).toBe('TEAM123456');
    expect(Math.abs((jwt.claims.iat as number) - Date.now() / 1000)).toBeLessThan(5);

    expect(JSON.parse(request!.body)).toEqual({
      aps: {
        alert: { title: 'STRUCTURE_FIRE', body: 'STRUCTURE_FIRE — 123 Main St' },
        sound: { critical: 1, name: 'default', volume: 1 },
        'interruption-level': 'critical',
        'mutable-content': 1,
      },
      category: 'dispatch',
      alertKind: 'dispatch',
      dispatchId: 'NICHOLS-MANUAL-1798000000-abcd1234',
      toneSequence: '2',
    });
  });

  it('derives apns-id deterministically from the exactly-once key, and a different tone gets a different id and collapse id', async () => {
    await send();
    await send();
    await send(apnsSecret(), {
      ...dispatch,
      toneSequence: 3,
      idempotencyKey: 'NICHOLS-MANUAL-1798000000-abcd1234#3#mbr-1#PUSH',
      collapseKey: 'NICHOLS-MANUAL-1798000000-abcd1234#3',
    });
    const ids = captured.map((c) => c.headers['apns-id']);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(captured[2]?.headers['apns-collapse-id']).not.toBe(
      captured[0]?.headers['apns-collapse-id'],
    );
  });

  it('reuses the provider token across sends (cached, not re-signed per page)', async () => {
    await send();
    await send();
    expect(captured[0]?.headers.authorization).toBe(captured[1]?.headers.authorization);
  });

  it('falls back to a time-sensitive alert when the secret says the Critical Alerts entitlement is not granted', async () => {
    await send(apnsSecret({ interruptionLevel: 'time-sensitive' }));
    const aps = (JSON.parse(captured[0]!.body) as { aps: Record<string, unknown> }).aps;
    expect(aps['interruption-level']).toBe('time-sensitive');
    expect(aps.sound).toBe('default');
  });

  it.each([
    [410, '{"reason":"Unregistered"}', 'APNS_Unregistered'],
    [400, '{"reason":"BadDeviceToken"}', 'APNS_BadDeviceToken'],
  ])('maps %i %s to a terminal invalid-token outcome', async (status, body, reason) => {
    reply = { status, body };
    await expect(send()).resolves.toEqual({ outcome: 'invalid_token', reason });
  });

  it('carries the 410 timestamp so a token re-registered after it is not invalidated', async () => {
    reply = { status: 410, body: '{"reason":"Unregistered","timestamp":1798000000000}' };
    await expect(send()).resolves.toEqual({
      outcome: 'invalid_token',
      reason: 'APNS_Unregistered',
      invalidSinceMs: 1798000000000,
    });
  });

  it('maps Unregistered with a status other than 410 to invalid-token (no timestamp)', async () => {
    reply = { status: 400, body: '{"reason":"Unregistered"}' };
    await expect(send()).resolves.toEqual({
      outcome: 'invalid_token',
      reason: 'APNS_Unregistered',
    });
  });

  it.each([
    [429, '{"reason":"TooManyRequests"}'],
    [500, '{"reason":"InternalServerError"}'],
    [503, '{"reason":"ServiceUnavailable"}'],
    [400, '{"reason":"BadTopic"}'],
    [400, '{"reason":"DeviceTokenNotForTopic"}'],
    [413, '{"reason":"PayloadTooLarge"}'],
  ])('throws on %i %s so SQS redelivers (never a silent drop)', async (status, body) => {
    reply = { status, body };
    await expect(send()).rejects.toThrow(`APNs responded ${status}`);
  });

  it.each(['InvalidProviderToken', 'ExpiredProviderToken'])(
    'on %s re-reads the secret (a rotated key) and retries once in-process with a token signed by the new key',
    async (reason) => {
      const rotated = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const secretsSend = vi
        .fn()
        .mockResolvedValueOnce({ SecretString: apnsSecret() })
        .mockResolvedValue({
          SecretString: apnsSecret({
            keyId: 'KEYROTATED',
            privateKey: rotated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          }),
        });
      const client = { send: secretsSend } as unknown as SecretsManagerClient;
      replyQueue.push({ status: 403, body: JSON.stringify({ reason }) });

      await expect(
        sendViaApns(dispatch, {
          secretId: 'apns-prod',
          isTest: false,
          secretsClient: client,
          timeoutMs: 4_000,
          origin,
        }),
      ).resolves.toMatchObject({ outcome: 'sent' });

      expect(captured).toHaveLength(2);
      expect(secretsSend).toHaveBeenCalledTimes(2);
      const retried = decodeJwt(
        String(captured[1]?.headers.authorization).slice('bearer '.length),
        rotated.publicKey,
      );
      expect(retried.valid).toBe(true);
      expect(retried.header.kid).toBe('KEYROTATED');
    },
  );

  it('throws after one in-process retry when the credentials are still refused, leaving nothing cached', async () => {
    const secretsSend = vi.fn().mockResolvedValue({ SecretString: apnsSecret() });
    const client = { send: secretsSend } as unknown as SecretsManagerClient;
    reply = { status: 403, body: '{"reason":"InvalidProviderToken"}' };
    const options = {
      secretId: 'apns-prod',
      isTest: false,
      secretsClient: client,
      timeoutMs: 4_000,
      origin,
    };

    await expect(sendViaApns(dispatch, options)).rejects.toThrow(
      'APNs responded 403 InvalidProviderToken',
    );
    expect(captured).toHaveLength(2);
    expect(secretsSend).toHaveBeenCalledTimes(2);

    // The redelivery reads the secret again rather than reusing the refused key.
    reply = { status: 200 };
    await sendViaApns(dispatch, options);
    expect(secretsSend).toHaveBeenCalledTimes(3);
  });

  it('rejects within the timeout when APNs accepts the stream but never answers', async () => {
    reply = { status: 0 };
    const started = Date.now();
    await expect(send(apnsSecret(), dispatch, { timeoutMs: 200 })).rejects.toThrow(
      'APNs request timed out after 200ms',
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('sendViaApns host selection and sandbox isolation', () => {
  afterEach(() => resetPushCredentialCaches());

  function recordingTransport(): { transport: Http2Transport; origins: string[] } {
    const origins: string[] = [];
    const transport: Http2Transport = (origin) => {
      origins.push(origin);
      return Promise.resolve({ status: 200, headers: {}, body: '' });
    };
    return { transport, origins };
  }

  it('sends a real page to the production gateway', async () => {
    const { transport, origins } = recordingTransport();
    await sendViaApns(dispatch, {
      secretId: 'apns-prod',
      isTest: false,
      secretsClient: secretsClient(apnsSecret()).client,
      timeoutMs: 4_000,
      transport,
    });
    expect(origins).toEqual(['https://api.push.apple.com']);
  });

  it('honours environment=sandbox on the prod secret (a dev stack whose app builds use sandbox tokens)', async () => {
    const { transport, origins } = recordingTransport();
    await sendViaApns(dispatch, {
      secretId: 'apns-prod',
      isTest: false,
      secretsClient: secretsClient(apnsSecret({ environment: 'sandbox' })).client,
      timeoutMs: 4_000,
      transport,
    });
    expect(origins).toEqual(['https://api.sandbox.push.apple.com']);
  });

  it('always sends a self-test/canary message to the sandbox gateway', async () => {
    const { transport, origins } = recordingTransport();
    await sendViaApns(dispatch, {
      secretId: 'apns-sandbox',
      isTest: true,
      secretsClient: secretsClient(apnsSecret()).client,
      timeoutMs: 4_000,
      transport,
    });
    expect(origins).toEqual(['https://api.sandbox.push.apple.com']);
  });

  it('refuses a sandbox secret that declares environment=production (fail closed, no send)', async () => {
    const { transport, origins } = recordingTransport();
    await expect(
      sendViaApns(dispatch, {
        secretId: 'apns-sandbox',
        isTest: true,
        secretsClient: secretsClient(apnsSecret({ environment: 'production' })).client,
        timeoutMs: 4_000,
        transport,
      }),
    ).rejects.toThrow('declares environment "production"');
    expect(origins).toEqual([]);
  });

  it.each(['teamId', 'keyId', 'privateKey', 'bundleId'])(
    'fails closed when the secret lacks %s',
    async (field) => {
      const { transport, origins } = recordingTransport();
      const secret = JSON.parse(apnsSecret()) as Record<string, unknown>;
      delete secret[field];
      await expect(
        sendViaApns(dispatch, {
          secretId: 'apns-prod',
          isTest: false,
          secretsClient: secretsClient(JSON.stringify(secret)).client,
          timeoutMs: 4_000,
          transport,
        }),
      ).rejects.toThrow(`missing required field ${field}`);
      expect(origins).toEqual([]);
    },
  );
});

describe('http2Transport connection handling (review M1)', () => {
  let server: Http2Server;
  let origin: string;
  const serverSessions: ServerHttp2Session[] = [];
  let mode: 'ok' | 'goaway-next' = 'ok';

  beforeAll(async () => {
    server = createServer();
    server.on('session', (session) => serverSessions.push(session));
    server.on('stream', (stream, headers) => {
      stream.on('error', () => undefined);
      if (mode === 'goaway-next') {
        mode = 'ok';
        // Refuse every stream on this connection, as APNs does when it drains one.
        stream.session?.goaway(constants.NGHTTP2_NO_ERROR, 0);
        stream.close(constants.NGHTTP2_REFUSED_STREAM);
        return;
      }
      const path = String(headers[':path']);
      if (path.endsWith('/goaway-after-sibling') && serverSessions.length === 1) {
        // APNs draining a connection: streams up to the sibling's are still served, this one
        // (and anything after it) is refused.
        stream.session?.goaway(constants.NGHTTP2_NO_ERROR, (stream.id ?? 3) - 2);
        stream.close(constants.NGHTTP2_REFUSED_STREAM);
        return;
      }
      if (path.endsWith('/hang')) return;
      const respond = () => {
        stream.respond({ ':status': 200 });
        stream.end('');
      };
      if (path.endsWith('/slow')) setTimeout(respond, 300);
      else stream.on('end', respond).resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    resetApnsSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    resetApnsSessions();
    serverSessions.length = 0;
    mode = 'ok';
    vi.useRealTimers();
  });

  const post = (path: string, timeoutMs = 2_000) =>
    http2Transport(origin, { ':path': `/3/device/${path}` }, '{}', timeoutMs);

  it('a connection the server closed while idle is replaced in-process: the next page still succeeds', async () => {
    await expect(post('first')).resolves.toMatchObject({ status: 200 });
    expect(serverSessions).toHaveLength(1);

    // The far side drops the connection; the client has not yet processed the close (as when
    // the Lambda was frozen) when the next page goes out on the cached session.
    serverSessions[0]!.destroy();
    await expect(post('second')).resolves.toMatchObject({ status: 200 });
    expect(serverSessions).toHaveLength(2);
  });

  it('a GOAWAY that refuses the page is retried once on a fresh connection', async () => {
    await post('warm');
    mode = 'goaway-next';
    await expect(post('after-goaway')).resolves.toMatchObject({ status: 200 });
    expect(serverSessions).toHaveLength(2);
  });

  // Review round 2 N1: the page that got refused by a GOAWAY must not tear down the
  // connection under a sibling page APNs already accepted on it.
  it('a GOAWAY refusing one page leaves an accepted sibling on the same connection to complete', async () => {
    await post('warm');
    const sibling = post('slow');
    // Let the sibling's stream reach the server before the refused one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const refused = post('goaway-after-sibling');

    const [siblingResult, refusedResult] = await Promise.all([sibling, refused]);

    expect(siblingResult.status).toBe(200);
    expect(refusedResult.status).toBe(200);
    expect(serverSessions).toHaveLength(2);
  });

  it('a session idle past the threshold is replaced before use, not trusted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await post('first');
    await post('soon-after');
    expect(serverSessions).toHaveLength(1);
    vi.setSystemTime(Date.now() + APNS_SESSION_MAX_IDLE_MS + 1_000);
    await post('after-idle');
    expect(serverSessions).toHaveLength(2);
  });

  it('a timed-out page cancels only its own stream: a sibling on the same connection still completes', async () => {
    const [hung, sibling] = await Promise.allSettled([post('hang', 100), post('slow', 2_000)]);

    expect(hung.status).toBe('rejected');
    expect((hung as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(String((hung as PromiseRejectedResult).reason)).toContain('timed out after 100ms');
    expect(sibling).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(serverSessions).toHaveLength(1);
    // The connection answered the PING, so it stays cached for the next page.
    await post('next');
    expect(serverSessions).toHaveLength(1);
  });

  it('classifies connection-level errors (and only those) as retryable on a fresh connection', () => {
    for (const code of [
      'ECONNRESET',
      'EPIPE',
      'ERR_HTTP2_GOAWAY_SESSION',
      'ERR_HTTP2_STREAM_ERROR',
    ]) {
      expect(isConnectionLevelError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    expect(isConnectionLevelError(new Error('APNs responded 500'))).toBe(false);
  });
});

describe('sendViaApns self-test configuration refusals (review M5)', () => {
  afterEach(() => resetPushCredentialCaches());

  const respond =
    (status: number, reason: string): Http2Transport =>
    () =>
      Promise.resolve({ status, headers: {}, body: JSON.stringify({ reason }) });

  const send = (isTest: boolean, transport: Http2Transport) =>
    sendViaApns(dispatch, {
      secretId: isTest ? 'apns-sandbox' : 'apns-prod',
      isTest,
      secretsClient: secretsClient(apnsSecret()).client,
      timeoutMs: 4_000,
      transport,
    });

  it.each(['DeviceTokenNotForTopic', 'TopicDisallowed', 'BadTopic'])(
    'a self-test %s is a terminal test failure',
    async (reason) => {
      await expect(send(true, respond(400, reason))).resolves.toEqual({
        outcome: 'test_refused',
        reason: `APNS_${reason}`,
      });
    },
  );

  it('a self-test whose provider token stays refused is a terminal test failure', async () => {
    await expect(send(true, respond(403, 'InvalidProviderToken'))).resolves.toEqual({
      outcome: 'test_refused',
      reason: 'APNS_CREDENTIALS_REFUSED',
    });
  });

  it('a real page with DeviceTokenNotForTopic still throws', async () => {
    await expect(send(false, respond(400, 'DeviceTokenNotForTopic'))).rejects.toThrow(
      'APNs responded 400 DeviceTokenNotForTopic',
    );
  });

  it('a self-test 503 still throws', async () => {
    await expect(send(true, respond(503, 'ServiceUnavailable'))).rejects.toThrow(
      'APNs responded 503',
    );
  });
});

describe('sendViaApns shares one deadline across the credential retry (review round 2 m1)', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetPushCredentialCaches();
  });

  /** Refuses the credentials after `elapsedMs` of (fake) time, then accepts. */
  function slowRefusalThenOk(elapsedMs: number): { transport: Http2Transport; timeouts: number[] } {
    const timeouts: number[] = [];
    const transport: Http2Transport = (_origin, _headers, _body, timeoutMs) => {
      timeouts.push(timeoutMs);
      if (timeouts.length === 1) {
        vi.setSystemTime(Date.now() + elapsedMs);
        return Promise.resolve({
          status: 403,
          headers: {},
          body: '{"reason":"InvalidProviderToken"}',
        });
      }
      return Promise.resolve({ status: 200, headers: {}, body: '' });
    };
    return { transport, timeouts };
  }

  const send = (transport: Http2Transport) =>
    sendViaApns(dispatch, {
      secretId: 'apns-prod',
      isTest: false,
      secretsClient: secretsClient(apnsSecret()).client,
      timeoutMs: 4_000,
      transport,
    });

  it('the retry gets only what is left of the 8s budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { transport, timeouts } = slowRefusalThenOk(5_000);

    await expect(send(transport)).resolves.toMatchObject({ outcome: 'sent' });

    expect(timeouts[0]).toBe(4_000);
    expect(timeouts[1]).toBeLessThanOrEqual(3_000);
    expect(timeouts[1]).toBeGreaterThan(2_900);
  });

  it('a retry with no budget left is not attempted; the page throws for SQS to redeliver', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { transport, timeouts } = slowRefusalThenOk(8_500);

    await expect(send(transport)).rejects.toThrow('push send budget exhausted');
    expect(timeouts).toHaveLength(1);
  });
});

describe('concurrent credential refusals evict once (review round 2 m2)', () => {
  afterEach(() => resetPushCredentialCaches());

  it('five pages refused with the same expired provider token re-read the secret once and mint one new token', async () => {
    const secretsSend = vi.fn().mockResolvedValue({ SecretString: apnsSecret() });
    const client = { send: secretsSend } as unknown as SecretsManagerClient;
    let refusedToken: string | undefined;
    const tokensUsed = new Set<string>();
    const transport: Http2Transport = async (_origin, headers) => {
      const auth = String(headers.authorization);
      tokensUsed.add(auth);
      refusedToken ??= auth;
      // Let every sibling's first attempt be in flight before any refusal lands.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return auth === refusedToken
        ? { status: 403, headers: {}, body: '{"reason":"ExpiredProviderToken"}' }
        : { status: 200, headers: {}, body: '' };
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        sendViaApns(dispatch, {
          secretId: 'apns-prod',
          isTest: false,
          secretsClient: client,
          timeoutMs: 4_000,
          transport,
        }),
      ),
    );

    expect(results.every((result) => result.outcome === 'sent')).toBe(true);
    expect(secretsSend).toHaveBeenCalledTimes(2);
    expect(tokensUsed.size).toBe(2);
  });
});
