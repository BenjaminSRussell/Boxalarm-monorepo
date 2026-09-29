import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetApnsSessions, sendViaApns, type Http2Transport } from './apnsAdapter.js';
import { resetPushCredentialCaches } from './pushCredentials.js';
import type { PushNotification } from './pushPayload.js';

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

  beforeAll(async () => {
    server = createServer();
    server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        captured.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
        if (reply.status === 0) return; // never answer: exercise the timeout
        stream.respond({ ':status': reply.status, 'apns-id': String(headers['apns-id']) });
        stream.end(reply.body ?? '');
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

  it('discards the cached provider token on ExpiredProviderToken so the redelivery signs a fresh one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await send();
      reply = { status: 403, body: '{"reason":"ExpiredProviderToken"}' };
      await expect(send()).rejects.toThrow('APNs responded 403 ExpiredProviderToken');
      vi.setSystemTime(Date.now() + 2_000);
      reply = { status: 200 };
      await send();
      expect(captured[2]?.headers.authorization).not.toBe(captured[0]?.headers.authorization);
    } finally {
      vi.useRealTimers();
    }
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
