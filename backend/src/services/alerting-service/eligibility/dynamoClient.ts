import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { ALERTING_SDK_CLIENT_CONFIG } from '../awsClientConfig.js';

export interface AlertingConfig {
  readonly tableName: string;
}

export function readAlertingConfig(env: NodeJS.ProcessEnv): AlertingConfig {
  const tableName = env.ALERTING_TABLE_NAME;
  if (!tableName) {
    throw new Error('ALERTING_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function createDynamoClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  readAlertingConfig(env);
  cachedClient ??=
    client ??
    DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient(ALERTING_SDK_CLIENT_CONFIG)));
  return cachedClient;
}
