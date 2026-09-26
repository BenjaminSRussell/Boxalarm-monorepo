import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { AuthorizerContext } from '../../platform-service/authorizer/handler.js';
import type { OccupancyRecord } from './repository.js';

type OccupancyEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

const DEPT_ID = 'dept-001';

const SAMPLE_RECORD: OccupancyRecord = {
  occupancyId: 'OCC-1',
  address: '456 Oak Ave',
  normalizedAddress: '456 OAK AVE',
  occupancyType: 'MULTI_FAMILY',
  contacts: [{ name: 'Pat Smith', phone: '203-555-0100', role: 'OWNER' }],
  hazards: ['PROPANE_TANK'],
  latitude: 41.2415,
  longitude: -73.2004,
};

function buildEvent(options: {
  readonly withAuth?: boolean;
  readonly withBearer?: boolean;
  readonly body?: string;
  readonly pathId?: string;
}): OccupancyEvent {
  const { withAuth = true, withBearer = true, body, pathId } = options;
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/api/v1/inspections/occupancies',
    rawQueryString: '',
    headers: withBearer ? { authorization: 'Bearer token-abc' } : {},
    ...(pathId !== undefined ? { pathParameters: { id: pathId } } : {}),
    ...(body !== undefined ? { body } : {}),
    isBase64Encoded: false,
    requestContext: {
      requestId: 'trace-1',
      ...(withAuth
        ? { authorizer: { lambda: { sub: 'member-1', deptId: DEPT_ID, 'cognito:groups': '' } } }
        : {}),
    } as unknown as OccupancyEvent['requestContext'],
  };
}

function mockAuthorization(overrides: {
  readonly assertOccupancyWriteAuthorized?: () => Promise<void>;
}): void {
  vi.doMock('./authorization.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./authorization.js')>();
    return {
      ...actual,
      assertOccupancyWriteAuthorized:
        overrides.assertOccupancyWriteAuthorized ?? (() => Promise.resolve()),
    };
  });
}

function mockRepository(overrides: {
  readonly getOccupancyById?: () => Promise<OccupancyRecord | undefined>;
  readonly createOccupancy?: () => Promise<OccupancyRecord>;
  readonly updateOccupancy?: () => Promise<OccupancyRecord>;
  readonly listOccupancies?: () => Promise<OccupancyRecord[]>;
}): void {
  vi.doMock('./repository.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./repository.js')>();
    return {
      ...actual,
      getOccupancyById: overrides.getOccupancyById ?? (() => Promise.resolve(SAMPLE_RECORD)),
      createOccupancy: overrides.createOccupancy ?? (() => Promise.resolve(SAMPLE_RECORD)),
      updateOccupancy: overrides.updateOccupancy ?? (() => Promise.resolve(SAMPLE_RECORD)),
      listOccupancies: overrides.listOccupancies ?? (() => Promise.resolve([SAMPLE_RECORD])),
    };
  });
}

describe('occupancy handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.OCCUPANCY_TABLE_NAME = 'boxalarm-test-platform-table';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'PSEXAMPLEabcdefg111111';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unmock('./authorization.js');
    vi.unmock('./repository.js');
    vi.restoreAllMocks();
  });

  describe('createOccupancyHandler', () => {
    it('returns 401 when no Authorization bearer token is present', async () => {
      mockAuthorization({});
      mockRepository({});
      const { createOccupancyHandler } = await import('./handler.js');
      const result = (await createOccupancyHandler(
        buildEvent({ withBearer: false }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(401);
    });

    it('returns 403 when Verified Permissions denies the write (AC4)', async () => {
      mockAuthorization({
        assertOccupancyWriteAuthorized: async () => {
          const { ForbiddenError } = await import('./authorization.js');
          throw new ForbiddenError('denied');
        },
      });
      mockRepository({});
      const { createOccupancyHandler } = await import('./handler.js');
      const result = (await createOccupancyHandler(
        buildEvent({ body: JSON.stringify({}) }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(403);
    });

    it('returns 201 and persists the plan on a valid admin create (AC1)', async () => {
      mockAuthorization({});
      const createOccupancy = vi.fn(() => Promise.resolve(SAMPLE_RECORD));
      mockRepository({ createOccupancy });
      const { createOccupancyHandler } = await import('./handler.js');
      const body = JSON.stringify({
        address: SAMPLE_RECORD.address,
        occupancyType: SAMPLE_RECORD.occupancyType,
        contacts: SAMPLE_RECORD.contacts,
        hazards: SAMPLE_RECORD.hazards,
        latitude: SAMPLE_RECORD.latitude,
        longitude: SAMPLE_RECORD.longitude,
      });
      const result = (await createOccupancyHandler(
        buildEvent({ body }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(201);
      expect(createOccupancy).toHaveBeenCalledTimes(1);
      const responseBody = JSON.parse(result.body as string) as { address: string };
      expect(responseBody.address).toBe(SAMPLE_RECORD.address);
    });

    it('returns 400 RFC7807 when required fields are missing', async () => {
      mockAuthorization({});
      mockRepository({});
      const { createOccupancyHandler } = await import('./handler.js');
      const result = (await createOccupancyHandler(
        buildEvent({ body: JSON.stringify({}) }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(400);
      expect(result.headers).toMatchObject({ 'content-type': 'application/problem+json' });
    });

    it('returns 500 problem+json when the repository rejects', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockAuthorization({});
      mockRepository({ createOccupancy: () => Promise.reject(new Error('ddb unavailable')) });
      const { createOccupancyHandler } = await import('./handler.js');
      const body = JSON.stringify({
        address: SAMPLE_RECORD.address,
        occupancyType: SAMPLE_RECORD.occupancyType,
        contacts: SAMPLE_RECORD.contacts,
        hazards: SAMPLE_RECORD.hazards,
      });
      const result = (await createOccupancyHandler(
        buildEvent({ body }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(500);
      expect(result.headers).toMatchObject({ 'content-type': 'application/problem+json' });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('occupancy.create.handler_failed'),
      );
    });
  });

  describe('getOccupancyHandler', () => {
    it('returns 200 with address/occupancyType/contacts/hazards on a found occupancy (AC2)', async () => {
      mockAuthorization({});
      mockRepository({ getOccupancyById: () => Promise.resolve(SAMPLE_RECORD) });
      const { getOccupancyHandler } = await import('./handler.js');
      const result = (await getOccupancyHandler(
        buildEvent({ pathId: 'OCC-1' }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({
        address: SAMPLE_RECORD.address,
        occupancyType: SAMPLE_RECORD.occupancyType,
        contacts: SAMPLE_RECORD.contacts,
        hazards: SAMPLE_RECORD.hazards,
      });
    });

    it('returns 404 when the occupancy does not exist', async () => {
      mockAuthorization({});
      mockRepository({ getOccupancyById: () => Promise.resolve(undefined) });
      const { getOccupancyHandler } = await import('./handler.js');
      const result = (await getOccupancyHandler(
        buildEvent({ pathId: 'OCC-missing' }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(404);
    });

    it('returns 500 problem+json when the repository rejects', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockAuthorization({});
      mockRepository({ getOccupancyById: () => Promise.reject(new Error('ddb unavailable')) });
      const { getOccupancyHandler } = await import('./handler.js');
      const result = (await getOccupancyHandler(
        buildEvent({ pathId: 'OCC-1' }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(500);
      expect(result.headers).toMatchObject({ 'content-type': 'application/problem+json' });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('occupancy.get.handler_failed'),
      );
    });
  });

  describe('listOccupanciesHandler', () => {
    it('returns 200 with { items } in the shape the web client reads (entrypoint wrapper)', async () => {
      mockAuthorization({});
      mockRepository({});
      const { handler } = await import('./listHandler.js');
      const result = (await handler(
        buildEvent({}),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string) as { items: Record<string, unknown>[] };
      expect(body.items).toEqual([
        {
          occupancyId: SAMPLE_RECORD.occupancyId,
          address: SAMPLE_RECORD.address,
          occupancyType: SAMPLE_RECORD.occupancyType,
          contacts: SAMPLE_RECORD.contacts,
          hazards: SAMPLE_RECORD.hazards,
          latitude: SAMPLE_RECORD.latitude,
          longitude: SAMPLE_RECORD.longitude,
        },
      ]);
    });

    it('returns 401 without a verified principal, before any DynamoDB read', async () => {
      mockAuthorization({});
      const listOccupancies = vi.fn(() => Promise.resolve([SAMPLE_RECORD]));
      mockRepository({ listOccupancies });
      const { listOccupanciesHandler } = await import('./handler.js');
      const result = (await listOccupanciesHandler(
        buildEvent({ withAuth: false }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(401);
      expect(listOccupancies).not.toHaveBeenCalled();
    });

    it('returns 503 problem+json and logs when the repository rejects', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockAuthorization({});
      mockRepository({ listOccupancies: () => Promise.reject(new Error('ddb unavailable')) });
      const { listOccupanciesHandler } = await import('./handler.js');
      const result = (await listOccupanciesHandler(
        buildEvent({}),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(503);
      expect(result.headers).toMatchObject({ 'content-type': 'application/problem+json' });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('occupancy.list.handler_failed'),
      );
    });
  });

  describe('entrypoint wrappers', () => {
    it.each([
      ['./createHandler.js', 'createOccupancyHandler'],
      ['./getHandler.js', 'getOccupancyHandler'],
      ['./updateHandler.js', 'updateOccupancyHandler'],
      ['./listHandler.js', 'listOccupanciesHandler'],
    ])('%s re-exports %s as the Lambda `handler`', async (entry, exportName) => {
      const wrapper = (await import(entry)) as { handler: unknown };
      const source = (await import('./handler.js')) as Record<string, unknown>;
      expect(wrapper.handler).toBe(source[exportName]);
    });
  });

  describe('updateOccupancyHandler', () => {
    it('returns 403 when a non-admin member attempts an edit (AC4)', async () => {
      mockAuthorization({
        assertOccupancyWriteAuthorized: async () => {
          const { ForbiddenError } = await import('./authorization.js');
          throw new ForbiddenError('denied');
        },
      });
      mockRepository({});
      const { updateOccupancyHandler } = await import('./handler.js');
      const result = (await updateOccupancyHandler(
        buildEvent({ pathId: 'OCC-1', body: JSON.stringify({ hazards: ['FLAMMABLE'] }) }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(403);
    });

    it('returns 404 when the occupancy id does not exist', async () => {
      mockAuthorization({});
      mockRepository({ getOccupancyById: () => Promise.resolve(undefined) });
      const { updateOccupancyHandler } = await import('./handler.js');
      const result = (await updateOccupancyHandler(
        buildEvent({ pathId: 'OCC-missing', body: JSON.stringify({ hazards: ['FLAMMABLE'] }) }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(404);
    });

    it('returns 200 on a valid contacts/hazards edit', async () => {
      mockAuthorization({});
      const updateOccupancy = vi.fn(() =>
        Promise.resolve({ ...SAMPLE_RECORD, hazards: ['FLAMMABLE'] }),
      );
      mockRepository({ getOccupancyById: () => Promise.resolve(SAMPLE_RECORD), updateOccupancy });
      const { updateOccupancyHandler } = await import('./handler.js');
      const result = (await updateOccupancyHandler(
        buildEvent({ pathId: 'OCC-1', body: JSON.stringify({ hazards: ['FLAMMABLE'] }) }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(200);
      expect(updateOccupancy).toHaveBeenCalledTimes(1);
    });

    it('returns 400 RFC7807 on an empty-body no-op patch', async () => {
      mockAuthorization({});
      mockRepository({});
      const { updateOccupancyHandler } = await import('./handler.js');
      const result = (await updateOccupancyHandler(
        buildEvent({ pathId: 'OCC-1', body: JSON.stringify({}) }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(400);
    });

    it('returns 500 problem+json when the pre-read GetItem fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockAuthorization({});
      mockRepository({ getOccupancyById: () => Promise.reject(new Error('ddb unavailable')) });
      const { updateOccupancyHandler } = await import('./handler.js');
      const result = (await updateOccupancyHandler(
        buildEvent({ pathId: 'OCC-1', body: JSON.stringify({ hazards: ['FLAMMABLE'] }) }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(500);
      expect(result.headers).toMatchObject({ 'content-type': 'application/problem+json' });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('occupancy.update.handler_failed'),
      );
    });

    it('returns 500 problem+json when the update transaction rejects', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockAuthorization({});
      mockRepository({
        getOccupancyById: () => Promise.resolve(SAMPLE_RECORD),
        updateOccupancy: () => Promise.reject(new Error('ddb unavailable')),
      });
      const { updateOccupancyHandler } = await import('./handler.js');
      const result = (await updateOccupancyHandler(
        buildEvent({ pathId: 'OCC-1', body: JSON.stringify({ hazards: ['FLAMMABLE'] }) }),
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2;
      expect(result.statusCode).toBe(500);
      expect(result.headers).toMatchObject({ 'content-type': 'application/problem+json' });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('occupancy.update.handler_failed'),
      );
    });
  });
});
