import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import type { SecretsManagerClientConfig } from '@aws-sdk/client-secrets-manager';
import { ALERTING_SDK_CLIENT_CONFIG } from './awsClientConfig.js';

afterEach(() => {
  vi.doUnmock('@aws-sdk/client-dynamodb');
  vi.doUnmock('@aws-sdk/client-secrets-manager');
  vi.resetModules();
});

describe('alerting SDK clients have bounded timeouts (review round 3 R3-2)', () => {
  it('bounds each attempt: 1s to connect, 2s to answer', () => {
    expect(ALERTING_SDK_CLIENT_CONFIG.requestHandler).toEqual({
      connectionTimeout: 1_000,
      requestTimeout: 2_000,
    });
  });

  it('the channel workers’ DynamoDB client is built with them', async () => {
    const constructed: unknown[] = [];
    vi.doMock('@aws-sdk/client-dynamodb', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
      class RecordingDynamoDBClient extends actual.DynamoDBClient {
        constructor(config: DynamoDBClientConfig) {
          constructed.push(config);
          super(config);
        }
      }
      return { ...actual, DynamoDBClient: RecordingDynamoDBClient };
    });
    const { createDynamoClient } = await import('./eligibility/dynamoClient.js');

    createDynamoClient({ ALERTING_TABLE_NAME: 't' });

    expect(constructed).toEqual([ALERTING_SDK_CLIENT_CONFIG]);
  });

  it('the push/SMS/voice Secrets Manager client is built with them', async () => {
    const constructed: unknown[] = [];
    vi.doMock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@aws-sdk/client-secrets-manager')>();
      class RecordingSecretsManagerClient extends actual.SecretsManagerClient {
        constructor(config: SecretsManagerClientConfig) {
          constructed.push(config);
          super(config);
        }
      }
      return { ...actual, SecretsManagerClient: RecordingSecretsManagerClient };
    });
    const { createChannelSecretsClient } = await import('./channels/httpProviderAdapter.js');

    createChannelSecretsClient();

    expect(constructed).toEqual([ALERTING_SDK_CLIENT_CONFIG]);
  });
});
