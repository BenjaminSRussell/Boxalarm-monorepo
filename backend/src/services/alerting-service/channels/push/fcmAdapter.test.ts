import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildFcmRequest, sendViaFcm } from './fcmAdapter.js';
import {
  FCM_OAUTH_SCOPE,
  GOOGLE_OAUTH_TOKEN_URL,
  resetPushCredentialCaches,
} from './pushCredentials.js';
import type { PushNotification } from './pushPayload.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'boxalarm-dev',
  private_key_id: 'kid-1',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  client_email: 'push@boxalarm-dev.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const dispatch: PushNotification = {
  token: 'fcm-registration-token:APA91b',
  alertKind: 'dispatch',
  dispatchId: 'NICHOLS-MANUAL-1798000000-abcd1234',
  toneSequence: 1,
  title: 'STRUCTURE_FIRE',
  body: 'STRUCTURE_FIRE — 123 Main St',
  idempotencyKey: 'NICHOLS-MANUAL-1798000000-abcd1234#1#mbr-1#PUSH',
  collapseKey: 'NICHOLS-MANUAL-1798000000-abcd1234#1',
};

interface Captured {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function secretsClient(secret = SERVICE_ACCOUNT): SecretsManagerClient {
  return {
    send: vi.fn().mockResolvedValue({ SecretString: secret }),
  } as unknown as SecretsManagerClient;
}

describe('sendViaFcm (FCM HTTP v1 against a local server)', () => {
  let server: Server;
  let origin: string;
  const captured: Captured[] = [];
  let sendReply: { status: number; body: unknown } = { status: 200, body: { name: 'msg/1' } };
  const sendReplyQueue: { status: number; body: unknown }[] = [];
  const tokenReplyQueue: { status: number; body: unknown }[] = [];
  let tokenCounter = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        captured.push({ url: req.url ?? '', headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/token') {
          const queued = tokenReplyQueue.shift();
          if (queued) {
            res.statusCode = queued.status;
            res.end(JSON.stringify(queued.body));
            return;
          }
          tokenCounter += 1;
          res.end(JSON.stringify({ access_token: `access-${tokenCounter}`, expires_in: 3599 }));
          return;
        }
        const next = sendReplyQueue.shift() ?? sendReply;
        res.statusCode = next.status;
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    captured.length = 0;
    sendReply = { status: 200, body: { name: 'msg/1' } };
    sendReplyQueue.length = 0;
    tokenReplyQueue.length = 0;
    tokenCounter = 0;
    resetPushCredentialCaches();
  });

  const send = (isTest = false, notification = dispatch) =>
    sendViaFcm(notification, {
      secretId: isTest ? 'fcm-sandbox' : 'fcm-prod',
      isTest,
      secretsClient: secretsClient(),
      timeoutMs: 4_000,
      fcmOrigin: origin,
      oauthTokenUrl: `${origin}/token`,
    });

  const sends = () => captured.filter((c) => c.url !== '/token');
  const tokenRequests = () => captured.filter((c) => c.url === '/token');

  it('exchanges a signed RS256 service-account assertion for an access token (JWT bearer grant)', async () => {
    await send();
    const [tokenRequest] = tokenRequests();
    const form = new URLSearchParams(tokenRequest!.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion')!.split('.') as [
      string,
      string,
      string,
    ];
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'kid-1',
    });
    const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<
      string,
      number | string
    >;
    expect(decoded).toMatchObject({
      iss: 'push@boxalarm-dev.iam.gserviceaccount.com',
      scope: FCM_OAUTH_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
    });
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(3600);
  });

  it('sends a HIGH-priority data message the app’s dispatch-critical handler reads, with the access token', async () => {
    const result = await send();

    expect(result).toEqual({ outcome: 'sent', providerMessageId: 'msg/1' });
    const [request] = sends();
    expect(request?.url).toBe('/v1/projects/boxalarm-dev/messages:send');
    expect(request?.headers.authorization).toBe('Bearer access-1');
    const body = JSON.parse(request!.body) as {
      validate_only?: boolean;
      message: Record<string, unknown>;
    };
    expect(body.validate_only).toBeUndefined();
    expect(body.message.token).toBe('fcm-registration-token:APA91b');
    // Data-only: no top-level `notification`, so the app's background handler always runs.
    expect(body.message.notification).toBeUndefined();
    // Bounded TTL: an offline phone must not ring hours later for a finished call.
    expect(body.message.android).toEqual({ priority: 'HIGH', ttl: '600s' });
    // Field names match ui/apps/mobile pushNotificationDisplay.ts (category/dispatchId/title/body).
    expect(body.message.data).toEqual({
      category: 'dispatch',
      alertKind: 'dispatch',
      dispatchId: 'NICHOLS-MANUAL-1798000000-abcd1234',
      toneSequence: '1',
      title: 'STRUCTURE_FIRE',
      body: 'STRUCTURE_FIRE — 123 Main St',
    });
    // A legacy iOS FCM token still gets a critical alert.
    const apns = body.message.apns as { headers: Record<string, string>; payload: { aps: object } };
    expect(apns.headers['apns-collapse-id']).toBe('NICHOLS-MANUAL-1798000000-abcd1234#1');
    expect(Number(apns.headers['apns-expiration']) - Date.now() / 1000).toBeGreaterThan(595);
    expect(apns.payload.aps).toMatchObject({ 'interruption-level': 'critical' });
  });

  it('caches the access token across sends', async () => {
    await send();
    await send();
    expect(tokenRequests()).toHaveLength(1);
    expect(sends().map((s) => s.headers.authorization)).toEqual([
      'Bearer access-1',
      'Bearer access-1',
    ]);
  });

  it('marks a self-test/canary send validate_only so FCM delivers nothing', async () => {
    await send(true);
    expect((JSON.parse(sends()[0]!.body) as { validate_only?: boolean }).validate_only).toBe(true);
  });

  it.each([
    [
      'UNREGISTERED',
      404,
      {
        error: {
          status: 'NOT_FOUND',
          message: 'Requested entity was not found.',
          details: [{ errorCode: 'UNREGISTERED' }],
        },
      },
      'FCM_UNREGISTERED',
    ],
    [
      'INVALID_ARGUMENT on message.token',
      400,
      {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'The registration token is not a valid FCM registration token',
          details: [
            { errorCode: 'INVALID_ARGUMENT' },
            { fieldViolations: [{ field: 'message.token' }] },
          ],
        },
      },
      'FCM_INVALID_ARGUMENT',
    ],
  ])('maps %s to a terminal invalid-token outcome', async (_label, status, body, reason) => {
    sendReply = { status, body };
    await expect(send()).resolves.toEqual({ outcome: 'invalid_token', reason });
  });

  it('maps INVALID_ARGUMENT naming the registration token only in its message (no field violation) to invalid-token', async () => {
    sendReply = {
      status: 400,
      body: {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'The registration token is not a valid FCM registration token',
          details: [{ errorCode: 'INVALID_ARGUMENT' }],
        },
      },
    };
    await expect(send()).resolves.toEqual({
      outcome: 'invalid_token',
      reason: 'FCM_INVALID_ARGUMENT',
    });
  });

  it.each([
    [
      '429 QUOTA_EXCEEDED',
      429,
      { error: { status: 'RESOURCE_EXHAUSTED', details: [{ errorCode: 'QUOTA_EXCEEDED' }] } },
    ],
    [
      '503 UNAVAILABLE',
      503,
      { error: { status: 'UNAVAILABLE', details: [{ errorCode: 'UNAVAILABLE' }] } },
    ],
    ['500 INTERNAL', 500, { error: { status: 'INTERNAL', details: [{ errorCode: 'INTERNAL' }] } }],
    // A bare 404 (e.g. wrong project_id) is a misconfiguration, never a dead token.
    ['404 without UNREGISTERED', 404, { error: { status: 'NOT_FOUND' } }],
    // A payload INVALID_ARGUMENT is a bug that must stay loud, not disable the device.
    [
      '400 INVALID_ARGUMENT on the payload',
      400,
      {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'Invalid data payload key',
          details: [
            { errorCode: 'INVALID_ARGUMENT' },
            { fieldViolations: [{ field: 'message.data' }] },
          ],
        },
      },
    ],
    [
      '403 SENDER_ID_MISMATCH',
      403,
      { error: { status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } },
    ],
  ])('throws on %s so SQS redelivers', async (_label, status, body) => {
    sendReply = { status, body };
    await expect(send()).rejects.toThrow(`FCM responded ${status}`);
  });

  it.each([
    ['401 UNAUTHENTICATED', 401, { error: { status: 'UNAUTHENTICATED' } }],
    ['403 PERMISSION_DENIED', 403, { error: { status: 'PERMISSION_DENIED' } }],
  ])(
    'on %s evicts the secret and access token and retries once in-process with fresh ones',
    async (_label, status, body) => {
      const secretsSend = vi.fn().mockResolvedValue({ SecretString: SERVICE_ACCOUNT });
      const options = {
        secretId: 'fcm-prod',
        isTest: false,
        secretsClient: { send: secretsSend } as unknown as SecretsManagerClient,
        timeoutMs: 4_000,
        fcmOrigin: origin,
        oauthTokenUrl: `${origin}/token`,
      };
      await sendViaFcm(dispatch, options);
      sendReplyQueue.push({ status, body });

      await expect(sendViaFcm(dispatch, options)).resolves.toMatchObject({ outcome: 'sent' });

      expect(secretsSend).toHaveBeenCalledTimes(2);
      expect(tokenRequests()).toHaveLength(2);
      expect(sends().map((s) => s.headers.authorization)).toEqual([
        'Bearer access-1',
        'Bearer access-1',
        'Bearer access-2',
      ]);
    },
  );

  it('throws after one in-process retry when FCM keeps refusing the credentials', async () => {
    sendReply = { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } };
    await expect(send()).rejects.toThrow('FCM responded 401');
    expect(sends()).toHaveLength(2);
    expect(tokenRequests()).toHaveLength(2);
  });

  it('a token endpoint refusing the service account (400 invalid_grant) re-reads the key and retries once', async () => {
    tokenReplyQueue.push({ status: 400, body: { error: 'invalid_grant' } });
    await expect(send()).resolves.toMatchObject({ outcome: 'sent' });
    expect(tokenRequests()).toHaveLength(2);
    expect(sends()).toHaveLength(1);
  });

  it('a SENDER_ID_MISMATCH is not a credential problem: no in-process credential retry', async () => {
    sendReply = {
      status: 403,
      body: {
        error: { status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] },
      },
    };
    await expect(send()).rejects.toThrow('FCM responded 403 SENDER_ID_MISMATCH');
    expect(sends()).toHaveLength(1);
  });

  it.each(['project_id', 'client_email', 'private_key'])(
    'fails closed when the service account lacks %s (no network call)',
    async (field) => {
      const secret = JSON.parse(SERVICE_ACCOUNT) as Record<string, unknown>;
      delete secret[field];
      await expect(
        sendViaFcm(dispatch, {
          secretId: 'fcm-prod',
          isTest: false,
          secretsClient: secretsClient(JSON.stringify(secret)),
          timeoutMs: 4_000,
          fcmOrigin: origin,
          oauthTokenUrl: `${origin}/token`,
        }),
      ).rejects.toThrow(`missing required field ${field}`);
      expect(captured).toHaveLength(0);
    },
  );
});

describe('sendViaFcm self-test configuration refusals (review M5)', () => {
  let server: Server;
  let origin: string;
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/token') {
          res.end(JSON.stringify({ access_token: 'access', expires_in: 3599 }));
          return;
        }
        res.statusCode = reply.status;
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => resetPushCredentialCaches());

  const send = (isTest: boolean) =>
    sendViaFcm(dispatch, {
      secretId: isTest ? 'fcm-sandbox' : 'fcm-prod',
      isTest,
      secretsClient: secretsClient(),
      timeoutMs: 4_000,
      fcmOrigin: origin,
      oauthTokenUrl: `${origin}/token`,
    });

  const senderMismatch = {
    status: 403,
    body: {
      error: { status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] },
    },
  };

  it('a self-test SENDER_ID_MISMATCH (sandbox service account in another project) is a terminal test failure', async () => {
    reply = senderMismatch;
    await expect(send(true)).resolves.toEqual({
      outcome: 'test_refused',
      reason: 'FCM_SENDER_ID_MISMATCH',
    });
  });

  it('a self-test whose credentials stay refused is a terminal test failure, not a DLQ page', async () => {
    reply = { status: 403, body: { error: { status: 'PERMISSION_DENIED' } } };
    await expect(send(true)).resolves.toEqual({
      outcome: 'test_refused',
      reason: 'FCM_CREDENTIALS_REFUSED',
    });
  });

  it('a real page with SENDER_ID_MISMATCH still throws (a misconfigured stack must page on-call)', async () => {
    reply = senderMismatch;
    await expect(send(false)).rejects.toThrow('FCM responded 403 SENDER_ID_MISMATCH');
  });

  it.each([429, 503])('a self-test %i still throws (transient, worth a retry)', async (status) => {
    reply = { status, body: { error: { status: 'UNAVAILABLE' } } };
    await expect(send(true)).rejects.toThrow(`FCM responded ${status}`);
  });
});

describe('buildFcmRequest apns block (review minor 4)', () => {
  it('honours the configured interruption level for a legacy iOS FCM token', () => {
    const request = buildFcmRequest(dispatch, false, Date.now(), 'time-sensitive') as {
      message: { apns: { payload: { aps: Record<string, unknown> } } };
    };
    expect(request.message.apns.payload.aps['interruption-level']).toBe('time-sensitive');
    expect(request.message.apns.payload.aps.sound).toBe('default');
  });

  it('reads apnsInterruptionLevel from the FCM secret and sends it', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url: string | URL | Request) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              (url as string).endsWith('/token')
                ? { access_token: 'a', expires_in: 3599 }
                : { name: 'msg/1' },
            ),
            { status: 200 },
          ),
        ),
      );
    try {
      const secret = JSON.stringify({
        ...(JSON.parse(SERVICE_ACCOUNT) as object),
        apnsInterruptionLevel: 'time-sensitive',
      });
      await sendViaFcm(dispatch, {
        secretId: 'fcm-level',
        isTest: false,
        secretsClient: secretsClient(secret),
        timeoutMs: 4_000,
        fcmOrigin: 'https://fcm.test',
        oauthTokenUrl: 'https://oauth.test/token',
      });
      const sendCall = fetchSpy.mock.calls.find(([url]) =>
        (url as string).includes('messages:send'),
      );
      const body = JSON.parse((sendCall?.[1] as RequestInit).body as string) as {
        message: { apns: { payload: { aps: Record<string, unknown> } } };
      };
      expect(body.message.apns.payload.aps['interruption-level']).toBe('time-sensitive');
    } finally {
      fetchSpy.mockRestore();
      resetPushCredentialCaches();
    }
  });

  it('refuses an invalid apnsInterruptionLevel (fail closed)', async () => {
    const secret = JSON.stringify({
      ...(JSON.parse(SERVICE_ACCOUNT) as object),
      apnsInterruptionLevel: 'loud',
    });
    await expect(
      sendViaFcm(dispatch, {
        secretId: 'fcm-bad-level',
        isTest: false,
        secretsClient: secretsClient(secret),
        timeoutMs: 4_000,
      }),
    ).rejects.toThrow('apnsInterruptionLevel must be');
  });
});

describe('sendViaFcm shares one deadline across the credential retry (review round 2 m1)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetPushCredentialCaches();
  });

  it('after a slow 401, the retry is not attempted once the 8s budget is spent (OAuth + send x2 cannot reach 16s)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url: string | URL | Request) => {
        if ((url as string).endsWith('/token')) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: 'a', expires_in: 3599 }), { status: 200 }),
          );
        }
        vi.setSystemTime(Date.now() + 8_500);
        return Promise.resolve(
          new Response(JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }), { status: 401 }),
        );
      });

    await expect(
      sendViaFcm(dispatch, {
        secretId: 'fcm-budget',
        isTest: false,
        secretsClient: secretsClient(),
        timeoutMs: 4_000,
        fcmOrigin: 'https://fcm.test',
        oauthTokenUrl: 'https://oauth.test/token',
      }),
    ).rejects.toThrow('push send budget exhausted');
    // One OAuth call and one send: nothing after the budget ran out.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('sendViaFcm survives a stale keep-alive connection (review round 2 m11)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetPushCredentialCaches();
  });

  const socketClosed = () =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });

  const send = () =>
    sendViaFcm(dispatch, {
      secretId: 'fcm-stale',
      isTest: false,
      secretsClient: secretsClient(),
      timeoutMs: 4_000,
      fcmOrigin: 'https://fcm.test',
      oauthTokenUrl: 'https://oauth.test/token',
    });

  it('a send whose reused connection was closed is retried once in-process and succeeds', async () => {
    let sends = 0;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url: string | URL | Request) => {
        if ((url as string).endsWith('/token')) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: 'a', expires_in: 3599 }), { status: 200 }),
          );
        }
        sends += 1;
        return sends === 1
          ? Promise.reject(socketClosed())
          : Promise.resolve(new Response(JSON.stringify({ name: 'm' }), { status: 200 }));
      });

    await expect(send()).resolves.toMatchObject({ outcome: 'sent' });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('the OAuth call is retried the same way', async () => {
    let tokenCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: string | URL | Request) => {
      if ((url as string).endsWith('/token')) {
        tokenCalls += 1;
        return tokenCalls === 1
          ? Promise.reject(socketClosed())
          : Promise.resolve(
              new Response(JSON.stringify({ access_token: 'a', expires_in: 3599 }), {
                status: 200,
              }),
            );
      }
      return Promise.resolve(new Response(JSON.stringify({ name: 'm' }), { status: 200 }));
    });

    await expect(send()).resolves.toMatchObject({ outcome: 'sent' });
    expect(tokenCalls).toBe(2);
  });

  it('a timeout is not retried in-process (the budget is spent); it throws for SQS', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url: string | URL | Request) =>
        (url as string).endsWith('/token')
          ? Promise.resolve(
              new Response(JSON.stringify({ access_token: 'a', expires_in: 3599 }), {
                status: 200,
              }),
            )
          : Promise.reject(
              new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
            ),
      );

    await expect(send()).rejects.toThrow('timeout');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
