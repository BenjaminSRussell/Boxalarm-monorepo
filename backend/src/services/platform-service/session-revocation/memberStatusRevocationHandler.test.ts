import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

function sqsRecord(body: unknown, messageId = 'msg-1'): SQSRecord {
  return { body: JSON.stringify(body), messageId } as SQSRecord;
}

function memberUpdatedEvent(memberId: string, status: string): Record<string, unknown> {
  return {
    eventId: 'evt-1',
    eventTime: '2026-09-14T00:00:00Z',
    eventType: 'personnel.member.updated',
    source: 'personnel-service',
    correlationId: 'corr-1',
    schemaVersion: '1.0',
    payload: { memberId, status },
  };
}

describe('memberStatusRevocationHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.COGNITO_USER_POOL_ID = 'pool-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unmock('./cognitoRevocationClient.js');
    vi.restoreAllMocks();
  });

  it('sends the Cognito revocation command for a LOA transition (entrypoint, core-harm)', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'LOA'))] };
    await handler(event, {} as never, () => undefined);

    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      { userPoolId: 'pool-1', username: 'mbr-102', correlationId: 'corr-1' },
    );
  });

  it('sends the Cognito revocation command for a RETIRED transition', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-200', 'RETIRED'))] };
    await handler(event, {} as never, () => undefined);

    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      { userPoolId: 'pool-1', username: 'mbr-200', correlationId: 'corr-1' },
    );
  });

  it('unwraps an EventBridge-shaped body (payload nested under detail) before parsing', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const eventBridgeWrapped = {
      version: '0',
      id: 'eb-evt-1',
      'detail-type': 'personnel.member.updated',
      source: 'personnel-service',
      time: '2026-09-14T00:00:00Z',
      detail: memberUpdatedEvent('mbr-eb-1', 'LOA'),
    };
    const event: SQSEvent = { Records: [sqsRecord(eventBridgeWrapped)] };
    await handler(event, {} as never, () => undefined);

    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      { userPoolId: 'pool-1', username: 'mbr-eb-1', correlationId: 'corr-1' },
    );
  });

  it('no-ops without calling Cognito when status is not LOA/RETIRED (e.g. ACTIVE)', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'ACTIVE'))] };
    await handler(event, {} as never, () => undefined);

    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  it('leaves other members untouched — only the event own memberId is ever passed as Username (survivor)', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = {
      Records: [
        sqsRecord(memberUpdatedEvent('mbr-777', 'LOA'), 'msg-1'),
        sqsRecord(memberUpdatedEvent('mbr-active-1', 'ACTIVE'), 'msg-2'),
      ],
    };
    await handler(event, {} as never, () => undefined);

    expect(revokeMemberSession).toHaveBeenCalledTimes(1);
    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ username: 'mbr-777' }),
    );
  });

  it('ignores a member.updated with no status (a profile, push-token or role change) instead of DLQing it', async () => {
    const revokeMemberSession = vi.fn();
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const rolesChange = {
      ...memberUpdatedEvent('mbr-102', 'LOA'),
      payload: { deptId: 'NICHOLS', memberId: 'mbr-102', roles: ['MEMBER', 'OFFICER'] },
    };
    const event: SQSEvent = { Records: [sqsRecord(rolesChange)] };

    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();
    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  it('rethrows (never swallows) on malformed payload — empty status — so SQS retries and the DLQ catches it', async () => {
    const revokeMemberSession = vi.fn();
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const malformed = memberUpdatedEvent('mbr-102', ' ');
    const event: SQSEvent = { Records: [sqsRecord(malformed)] };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'payload.status is required',
    );
    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  it('rethrows on malformed payload — whitespace-only memberId', async () => {
    const revokeMemberSession = vi.fn();
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const malformed = memberUpdatedEvent('   ', 'LOA');
    const event: SQSEvent = { Records: [sqsRecord(malformed)] };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'payload.memberId is required',
    );
  });

  it('rethrows when a record has the wrong eventType for this queue', async () => {
    const revokeMemberSession = vi.fn();
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const wrongEvent = {
      ...memberUpdatedEvent('mbr-102', 'LOA'),
      eventType: 'personnel.member.created',
    };
    const event: SQSEvent = { Records: [sqsRecord(wrongEvent)] };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'unexpected eventType',
    );
    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  it('still revokes the valid record in a batch even when an earlier record is malformed', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const malformed = memberUpdatedEvent('mbr-bad', '');
    const event: SQSEvent = {
      Records: [
        sqsRecord(malformed, 'msg-bad'),
        sqsRecord(memberUpdatedEvent('mbr-200', 'RETIRED'), 'msg-good'),
      ],
    };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'payload.status is required',
    );
    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      { userPoolId: 'pool-1', username: 'mbr-200', correlationId: 'corr-1' },
    );
  });

  it('rethrows when Cognito is unavailable, never swallowing, so SQS visibility-timeout retry can do its job', async () => {
    const revokeMemberSession = vi.fn().mockRejectedValue(new Error('Cognito unreachable'));
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'LOA'))] };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'Cognito unreachable',
    );
  });

  it('no-ops (logged, non-retryable) when the member is unknown to Cognito, avoiding a DLQ storm', async () => {
    const revokeMemberSession = vi
      .fn()
      .mockRejectedValue(new UserNotFoundException({ message: 'no such user', $metadata: {} }));
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-ghost', 'LOA'))] };

    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();
  });

  it('logs and rethrows when the revocation config is missing (e.g. COGNITO_USER_POOL_ID unset)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => {
        throw new Error('COGNITO_USER_POOL_ID is required and was not set');
      },
      createRevocationClient: () => ({}),
      revokeMemberSession: vi.fn(),
    }));

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'LOA'))] };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'COGNITO_USER_POOL_ID is required',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('memberStatusRevocation.configError'),
    );
  });
});
