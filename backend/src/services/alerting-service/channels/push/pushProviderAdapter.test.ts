import { generateKeyPairSync } from 'node:crypto';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Http2Transport } from './apnsAdapter.js';
import type { PushNotification } from './pushPayload.js';

const P8 = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const notification: PushNotification = {
  token: 'b'.repeat(64),
  alertKind: 'dispatch',
  dispatchId: 'dispatch-1',
  toneSequence: 1,
  title: 'STRUCTURE_FIRE',
  body: 'STRUCTURE_FIRE — 12 Main St',
  idempotencyKey: 'dispatch-1#1#mbr-1#PUSH',
  collapseKey: 'dispatch-1#1',
};

function secretsBySecretId(): { client: SecretsManagerClient; ids: string[] } {
  const ids: string[] = [];
  const send = vi.fn((command: { input: { SecretId: string } }) => {
    ids.push(command.input.SecretId);
    return Promise.resolve({
      SecretString: JSON.stringify({
        teamId: 'TEAM',
        keyId: command.input.SecretId,
        privateKey: P8,
        bundleId: 'org.nicholsfd.boxalarm',
      }),
    });
  });
  return { client: { send } as unknown as SecretsManagerClient, ids };
}

function okTransport(): { transport: Http2Transport; origins: string[] } {
  const origins: string[] = [];
  return {
    origins,
    transport: (origin) => {
      origins.push(origin);
      return Promise.resolve({ status: 200, headers: {}, body: '' });
    },
  };
}

const env = {
  APNS_SECRET_ID: 'apns-prod',
  APNS_SANDBOX_SECRET_ID: 'apns-sandbox',
  FCM_SECRET_ID: 'fcm-prod',
  FCM_SANDBOX_SECRET_ID: 'fcm-sandbox',
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolvePushPlatform', () => {
  it.each([
    ['APNS', 'x', 'APNS'],
    ['ios', 'x', 'APNS'],
    ['FCM', 'b'.repeat(64), 'FCM'],
    ['android', 'x', 'FCM'],
    [undefined, 'c'.repeat(64), 'APNS'],
    [undefined, 'fcm:APA91b-token', 'FCM'],
  ])('platform %s with token %s → %s', async (platform, token, expected) => {
    const { resolvePushPlatform } = await import('./pushProviderAdapter.js');
    expect(resolvePushPlatform(platform, token)).toBe(expected);
  });
});

describe('sendPush sandbox isolation (architecture §1.3)', () => {
  it('a real page reads only the prod APNs secret and goes to the production gateway', async () => {
    const { sendPush } = await import('./pushProviderAdapter.js');
    const secrets = secretsBySecretId();
    const { transport, origins } = okTransport();

    await sendPush(notification, 'APNS', env, {
      secretsClient: secrets.client,
      apnsTransport: transport,
    });

    expect(secrets.ids).toEqual(['apns-prod']);
    expect(origins).toEqual(['https://api.push.apple.com']);
  });

  it('a self-test/canary reads only the sandbox APNs secret and goes to the sandbox gateway', async () => {
    const { sendPush } = await import('./pushProviderAdapter.js');
    const secrets = secretsBySecretId();
    const { transport, origins } = okTransport();

    await sendPush(notification, 'APNS', env, {
      isTest: true,
      secretsClient: secrets.client,
      apnsTransport: transport,
    });

    expect(secrets.ids).toEqual(['apns-sandbox']);
    expect(origins).toEqual(['https://api.sandbox.push.apple.com']);
  });

  it.each([
    ['APNS', 'APNS_SANDBOX_SECRET_ID'],
    ['FCM', 'FCM_SANDBOX_SECRET_ID'],
  ] as const)(
    'fails closed when a %s test message has no sandbox secret (no prod fallback, no network)',
    async (platform, missing) => {
      const { sendPush } = await import('./pushProviderAdapter.js');
      const secrets = secretsBySecretId();
      const { transport, origins } = okTransport();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(
        sendPush(
          notification,
          platform,
          { ...env, [missing]: undefined },
          { isTest: true, secretsClient: secrets.client, apnsTransport: transport },
        ),
      ).rejects.toThrow(`${missing} is required and was not set`);
      expect(secrets.ids).toEqual([]);
      expect(origins).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('keeps prod and sandbox provider tokens in separate cache slots', async () => {
    const { sendPush } = await import('./pushProviderAdapter.js');
    const secrets = secretsBySecretId();
    const authorizations: unknown[] = [];
    const transport: Http2Transport = (_origin, headers) => {
      authorizations.push(headers.authorization);
      return Promise.resolve({ status: 200, headers: {}, body: '' });
    };

    await sendPush(notification, 'APNS', env, {
      secretsClient: secrets.client,
      apnsTransport: transport,
    });
    await sendPush(notification, 'APNS', env, {
      isTest: true,
      secretsClient: secrets.client,
      apnsTransport: transport,
    });

    const kids = authorizations.map((auth) => {
      const header = String(auth).slice('bearer '.length).split('.')[0]!;
      return (JSON.parse(Buffer.from(header, 'base64url').toString()) as { kid: string }).kid;
    });
    expect(kids).toEqual(['apns-prod', 'apns-sandbox']);
  });

  it('an iOS page does not need the FCM secret configured (and vice versa)', async () => {
    const { sendPush } = await import('./pushProviderAdapter.js');
    const secrets = secretsBySecretId();
    const { transport } = okTransport();
    await expect(
      sendPush(
        notification,
        'APNS',
        { APNS_SECRET_ID: 'apns-prod' },
        { secretsClient: secrets.client, apnsTransport: transport },
      ),
    ).resolves.toEqual({ outcome: 'sent' });
  });
});

describe('credential reads are coalesced across concurrent sends (review minor 5)', () => {
  it('ten concurrent APNs pages on a cold container read the secret once', async () => {
    const { sendPush } = await import('./pushProviderAdapter.js');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await gate;
      return {
        SecretString: JSON.stringify({
          teamId: 'TEAM',
          keyId: 'KEY',
          privateKey: P8,
          bundleId: 'org.nicholsfd.boxalarm',
        }),
      };
    });
    const { transport } = okTransport();
    const pending = Array.from({ length: 10 }, () =>
      sendPush(notification, 'APNS', env, {
        secretsClient: { send } as unknown as SecretsManagerClient,
        apnsTransport: transport,
      }),
    );
    release();
    await expect(Promise.all(pending)).resolves.toHaveLength(10);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ten concurrent FCM pages fetch one OAuth token', async () => {
    const { sendPush } = await import('./pushProviderAdapter.js');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    const secrets = {
      send: vi.fn(() =>
        Promise.resolve({
          SecretString: JSON.stringify({
            project_id: 'p',
            client_email: 'sa@p.iam.gserviceaccount.com',
            private_key: rsa.toString(),
          }),
        }),
      ),
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url: string | URL | Request) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              (url as string).endsWith('/token')
                ? { access_token: 'a', expires_in: 3599 }
                : { name: 'm' },
            ),
            { status: 200 },
          ),
        ),
      );
    await Promise.all(
      Array.from({ length: 10 }, () =>
        sendPush({ ...notification, token: 'fcm' }, 'FCM', env, {
          secretsClient: secrets as unknown as SecretsManagerClient,
          fcmOrigin: 'https://fcm.test',
          oauthTokenUrl: 'https://oauth.test/token',
        }),
      ),
    );
    const tokenCalls = fetchSpy.mock.calls.filter(([url]) => (url as string).endsWith('/token'));
    expect(tokenCalls).toHaveLength(1);
    // One read of the FCM secret (the APNs secret is also read once, for the interruption level).
    const fcmReads = (
      secrets.send.mock.calls as unknown as [{ input: { SecretId: string } }][]
    ).filter(([command]) => command.input.SecretId === 'fcm-prod');
    expect(fcmReads).toHaveLength(1);
  });
});

describe('one interruption level for both gateways (review round 2 m9)', () => {
  function fcmServiceAccount(extra: Record<string, unknown> = {}) {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    return JSON.stringify({
      project_id: 'p',
      client_email: 'sa@p.iam.gserviceaccount.com',
      private_key: rsa.toString(),
      ...extra,
    });
  }

  async function fcmApnsLevel(
    secrets: Record<string, string>,
    envOverride: NodeJS.ProcessEnv = env,
  ) {
    const { sendPush } = await import('./pushProviderAdapter.js');
    const client = {
      send: vi.fn((command: { input: { SecretId: string } }) => {
        const value = secrets[command.input.SecretId];
        return value
          ? Promise.resolve({ SecretString: value })
          : Promise.reject(new Error('ResourceNotFoundException'));
      }),
    } as unknown as SecretsManagerClient;
    let body: { message: { apns: { payload: { aps: Record<string, unknown> } } } } | undefined;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        if ((url as string).endsWith('/token')) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: 'a', expires_in: 3599 }), { status: 200 }),
          );
        }
        body = JSON.parse(init?.body as string) as typeof body;
        return Promise.resolve(new Response(JSON.stringify({ name: 'm' }), { status: 200 }));
      });
    await sendPush({ ...notification, token: 'fcm' }, 'FCM', envOverride, {
      secretsClient: client,
      fcmOrigin: 'https://fcm.test',
      oauthTokenUrl: 'https://oauth.test/token',
    });
    fetchSpy.mockRestore();
    return body?.message.apns.payload.aps['interruption-level'];
  }

  const apnsSecret = (level: string) =>
    JSON.stringify({
      teamId: 'TEAM',
      keyId: 'KEY',
      privateKey: P8,
      bundleId: 'org.nicholsfd.boxalarm',
      interruptionLevel: level,
    });

  it('FCM follows the APNs secret, which wins over a conflicting FCM secret value', async () => {
    await expect(
      fcmApnsLevel({
        'apns-prod': apnsSecret('time-sensitive'),
        'fcm-prod': fcmServiceAccount({ apnsInterruptionLevel: 'critical' }),
      }),
    ).resolves.toBe('time-sensitive');
  });

  it('an unreadable APNs secret never blocks an Android page: FCM falls back to its own value', async () => {
    await expect(
      fcmApnsLevel({ 'fcm-prod': fcmServiceAccount({ apnsInterruptionLevel: 'time-sensitive' }) }),
    ).resolves.toBe('time-sensitive');
  });

  it('with no APNs secret configured at all, FCM defaults to critical', async () => {
    await expect(
      fcmApnsLevel({ 'fcm-prod': fcmServiceAccount() }, { FCM_SECRET_ID: 'fcm-prod' }),
    ).resolves.toBe('critical');
  });
});

describe('the Android path caches the APNs-level lookup, failures included (review round 3 R3-1)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('an unreadable APNs secret is tried once per minute, not once per Android page', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { sendPush, APNS_LEVEL_LOOKUP_TTL_MS } = await import('./pushProviderAdapter.js');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    const reads: string[] = [];
    const client = {
      send: vi.fn((command: { input: { SecretId: string } }) => {
        reads.push(command.input.SecretId);
        return command.input.SecretId === 'fcm-prod'
          ? Promise.resolve({
              SecretString: JSON.stringify({
                project_id: 'p',
                client_email: 'sa@p.iam.gserviceaccount.com',
                private_key: rsa.toString(),
              }),
            })
          : Promise.reject(new Error('AccessDeniedException'));
      }),
    } as unknown as SecretsManagerClient;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: string | URL | Request) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            (url as string).endsWith('/token')
              ? { access_token: 'a', expires_in: 3599 }
              : { name: 'm' },
          ),
          { status: 200 },
        ),
      ),
    );
    const page = () =>
      sendPush({ ...notification, token: 'fcm' }, 'FCM', env, {
        secretsClient: client,
        fcmOrigin: 'https://fcm.test',
        oauthTokenUrl: 'https://oauth.test/token',
      });
    const apnsReads = () => reads.filter((id) => id === 'apns-prod').length;

    await expect(page()).resolves.toMatchObject({ outcome: 'sent' });
    await expect(page()).resolves.toMatchObject({ outcome: 'sent' });
    await expect(page()).resolves.toMatchObject({ outcome: 'sent' });
    expect(apnsReads()).toBe(1);

    vi.setSystemTime(Date.now() + APNS_LEVEL_LOOKUP_TTL_MS + 1_000);
    await expect(page()).resolves.toMatchObject({ outcome: 'sent' });
    expect(apnsReads()).toBe(2);
  });
});
