import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const POLICY_STORE_ID = 'PSEXAMPLEabcdefg111111';

function fakeMiddlewareStack() {
  return { use: () => undefined, remove: () => undefined };
}

function mockVerifiedPermissionsClient(send: (command: unknown) => Promise<unknown>): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
    class FakeVerifiedPermissionsClient {
      middlewareStack = fakeMiddlewareStack();
      config = {};
      send = send;
    }
    return { ...actual, VerifiedPermissionsClient: FakeVerifiedPermissionsClient };
  });
}

describe('assertOccupancyWriteAuthorized', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unmock('@aws-sdk/client-verifiedpermissions');
    vi.restoreAllMocks();
  });

  it('resolves without throwing when Verified Permissions returns ALLOW', async () => {
    mockVerifiedPermissionsClient(() => Promise.resolve({ decision: 'ALLOW' }));
    const { assertOccupancyWriteAuthorized } = await import('./authorization.js');
    await expect(
      assertOccupancyWriteAuthorized(
        { policyStoreId: POLICY_STORE_ID },
        'token-abc',
        'OCC-1',
        'trace-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('asks for the namespace-qualified Boxalarm::Action WriteOccupancy on the occupancy', async () => {
    const send = vi.fn().mockResolvedValue({ decision: 'ALLOW' });
    mockVerifiedPermissionsClient(send);
    const { assertOccupancyWriteAuthorized } = await import('./authorization.js');
    await assertOccupancyWriteAuthorized(
      { policyStoreId: POLICY_STORE_ID },
      'token-abc',
      'OCC-1',
      'trace-1',
    );
    const command = send.mock.calls[0]?.[0] as { input: { action: unknown; resource: unknown } };
    expect(command.input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'WriteOccupancy',
    });
    expect(command.input.resource).toEqual({
      entityType: 'Boxalarm::Occupancy',
      entityId: 'OCC-1',
    });
  });

  it('throws ForbiddenError when Verified Permissions returns DENY (AC4, 403)', async () => {
    mockVerifiedPermissionsClient(() => Promise.resolve({ decision: 'DENY' }));
    const { assertOccupancyWriteAuthorized, ForbiddenError } = await import('./authorization.js');
    await expect(
      assertOccupancyWriteAuthorized(
        { policyStoreId: POLICY_STORE_ID },
        'token-abc',
        'OCC-1',
        'trace-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throws ServiceUnavailableError (never a defaulted allow) when Verified Permissions itself throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockVerifiedPermissionsClient(() => Promise.reject(new Error('VP outage')));
    const { assertOccupancyWriteAuthorized, ServiceUnavailableError } =
      await import('./authorization.js');
    await expect(
      assertOccupancyWriteAuthorized(
        { policyStoreId: POLICY_STORE_ID },
        'token-abc',
        'OCC-1',
        'trace-1',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('occupancy.authorization.error'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('trace-1'));
  });

  it('reuses a single cached client across calls (lazy singleton)', async () => {
    let constructCount = 0;
    vi.doMock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
      class FakeVerifiedPermissionsClient {
        middlewareStack = fakeMiddlewareStack();
        config = {};
        send = () => Promise.resolve({ decision: 'ALLOW' });
        constructor() {
          constructCount += 1;
        }
      }
      return { ...actual, VerifiedPermissionsClient: FakeVerifiedPermissionsClient };
    });
    const { assertOccupancyWriteAuthorized } = await import('./authorization.js');
    await assertOccupancyWriteAuthorized(
      { policyStoreId: POLICY_STORE_ID },
      'token-abc',
      'OCC-1',
      'trace-1',
    );
    await assertOccupancyWriteAuthorized(
      { policyStoreId: POLICY_STORE_ID },
      'token-abc',
      'OCC-2',
      'trace-2',
    );
    expect(constructCount).toBe(1);
  });
});
