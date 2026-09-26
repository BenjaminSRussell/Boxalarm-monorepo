import { describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError, toProblemResponse } from './problemDetails.js';

describe('toProblemResponse', () => {
  it('maps a ValidationError to a 400 RFC 7807 problem+json body carrying the traceId', () => {
    const response = toProblemResponse(
      new ValidationError('serialNumber is required'),
      '/api/v1/inventory/equipment',
      'trace-1',
    );
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(response.body)).toEqual({
      type: 'about:blank',
      title: 'Validation Failed',
      status: 400,
      detail: 'serialNumber is required',
      instance: '/api/v1/inventory/equipment',
      traceId: 'trace-1',
    });
  });

  it('maps a NotFoundError to a 404 problem', () => {
    const response = toProblemResponse(new NotFoundError('asset AS-1 not found'), '/x', 'trace-2');
    expect(response.statusCode).toBe(404);
  });

  it('fail-closed: maps an unrecognized error to a 500 problem rather than leaking internals', () => {
    const response = toProblemResponse(new Error('DynamoDB unavailable'), '/x', 'trace-3');
    expect(response.statusCode).toBe(500);
    expect((JSON.parse(response.body) as Record<string, unknown>).detail).toBe(
      'An unexpected error occurred',
    );
  });
});
