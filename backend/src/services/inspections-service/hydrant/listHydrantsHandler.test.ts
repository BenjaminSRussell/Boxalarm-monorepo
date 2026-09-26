import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { BatchGetCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../../platform-service/authorizer/handler.js';
import { handler } from './listHydrantsHandler.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const validAuthorizer: AuthorizerContext = {
  sub: 'mbr-102',
  deptId: 'NICHOLS',
  'cognito:groups': '',
};

function buildEvent(overrides: {
  queryStringParameters?: Record<string, string>;
  authorizer?: Partial<AuthorizerContext>;
}): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/inspections/hydrants',
    rawPath: '/api/v1/inspections/hydrants',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    queryStringParameters: overrides.queryStringParameters,
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.boxalarm.dev',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/api/v1/inspections/hydrants',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/v1/inspections/hydrants',
      stage: '$default',
      time: '03/Sep/2026:00:00:00 +0000',
      timeEpoch: Date.now(),
      authorizer: { lambda: overrides.authorizer },
    },
  } as unknown as APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;
}

beforeEach(() => {
  ddbMock.reset();
  process.env.PLATFORM_TABLE_NAME = 'boxalarm-platform-table';
});

describe('listHydrantsHandler (entrypoint, AC3/AC4)', () => {
  it('returns 200 with the hydrants due within the requested month (AC4 wiring)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ hydrantId: 'HYD-0231', status: 'IN_SERVICE' }] });
    const result = (await handler(
      buildEvent({ queryStringParameters: { dueBefore: '2027-01' }, authorizer: validAuthorizer }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { hydrants: unknown[] };
    expect(body.hydrants).toEqual([{ hydrantId: 'HYD-0231', status: 'IN_SERVICE' }]);
  });

  it('denies with 401 when the authorizer context is missing', async () => {
    const result = (await handler(
      buildEvent({ queryStringParameters: { dueBefore: '2027-01' } }),
      {} as never,
      () => undefined,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('returns the full department hydrant list (GSI3) when dueBefore is absent, as the web Hydrants page calls it', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ hydrantId: 'HYD-0231' }] });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'boxalarm-platform-table': [{ hydrantId: 'HYD-0231', status: 'IN_SERVICE' }] },
    });
    const result = (await handler(
      buildEvent({ authorizer: validAuthorizer }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect((JSON.parse(result.body) as { hydrants: unknown[] }).hydrants).toEqual([
      { hydrantId: 'HYD-0231', status: 'IN_SERVICE' },
    ]);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.IndexName).toBe('GSI3');
  });

  it('rejects a malformed dueBefore with 400 RFC7807', async () => {
    const result = (await handler(
      buildEvent({ queryStringParameters: { dueBefore: '2027-1' }, authorizer: validAuthorizer }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; headers: Record<string, string> };
    expect(result.statusCode).toBe(400);
    expect(result.headers['content-type']).toBe('application/problem+json');
  });

  it('fails closed with 503 when DynamoDB is unavailable', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('simulated outage'));
    const result = (await handler(
      buildEvent({ queryStringParameters: { dueBefore: '2027-01' }, authorizer: validAuthorizer }),
      {} as never,
      () => undefined,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(503);
  });
});
