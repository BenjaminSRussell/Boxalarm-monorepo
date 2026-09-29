import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sendViaFcm } from './fcmAdapter.js';
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
          tokenCounter += 1;
          res.end(JSON.stringify({ access_token: `access-${tokenCounter}`, expires_in: 3599 }));
          return;
        }
        res.statusCode = sendReply.status;
        res.end(JSON.stringify(sendReply.body));
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
    expect(body.message.android).toEqual({ priority: 'HIGH' });
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

  it('drops the cached access token on 401 so the redelivery fetches a fresh one', async () => {
    await send();
    sendReply = { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } };
    await expect(send()).rejects.toThrow('FCM responded 401');
    sendReply = { status: 200, body: { name: 'msg/2' } };
    await send();
    expect(tokenRequests()).toHaveLength(2);
    expect(sends().at(-1)?.headers.authorization).toBe('Bearer access-2');
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
