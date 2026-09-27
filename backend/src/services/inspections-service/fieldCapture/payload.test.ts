import { describe, expect, it } from 'vitest';
import { ValidationError } from '../inspectionRecord.js';
import { FieldCaptureValidationError, parseFieldCapturePayload } from './payload.js';

describe('parseFieldCapturePayload', () => {
  it('accepts a well-formed field-capture body with photos and violations', () => {
    expect(
      parseFieldCapturePayload({
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        idempotencyKey: 'idem-001',
        photoFilenames: ['photo1.jpg'],
        violations: [{ code: 'V1', description: 'bad wiring', status: 'open' }],
      }),
    ).toEqual({
      occupancyId: 'OCC-1',
      inspectionId: 'INS-1',
      idempotencyKey: 'idem-001',
      photoFilenames: ['photo1.jpg'],
      violations: [{ code: 'V1', description: 'bad wiring', status: 'open' }],
    });
  });

  it('defaults absent photoFilenames/violations to empty arrays', () => {
    const result = parseFieldCapturePayload({
      occupancyId: 'OCC-1',
      inspectionId: 'INS-1',
      idempotencyKey: 'idem-001',
    });
    expect(result.photoFilenames).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it.each([
    [null, FieldCaptureValidationError],
    ['a string body', FieldCaptureValidationError],
    [{}, FieldCaptureValidationError],
    [{ occupancyId: '' }, FieldCaptureValidationError],
    [{ occupancyId: 42 }, FieldCaptureValidationError],
    [
      { occupancyId: 'OCC#1', inspectionId: 'INS-1', idempotencyKey: 'k' },
      FieldCaptureValidationError,
    ],
    [
      { occupancyId: 'OCC-1', inspectionId: 'INS#1', idempotencyKey: 'k' },
      FieldCaptureValidationError,
    ],
    [{ occupancyId: 'OCC-1', inspectionId: 'INS-1' }, FieldCaptureValidationError],
    [
      { occupancyId: 'OCC-1', inspectionId: 'INS-1', idempotencyKey: '' },
      FieldCaptureValidationError,
    ],
    [
      { occupancyId: 'OCC-1', inspectionId: 'INS-1', idempotencyKey: {} },
      FieldCaptureValidationError,
    ],
    [
      { occupancyId: 'OCC-1', inspectionId: 'INS-1', idempotencyKey: 'k', photoFilenames: 'x.jpg' },
      FieldCaptureValidationError,
    ],
    [
      {
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        idempotencyKey: 'k',
        photoFilenames: ['../../OTHERDEPT/x.jpg'],
      },
      FieldCaptureValidationError,
    ],
    [
      {
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        idempotencyKey: 'k',
        violations: 'not-an-array',
      },
      FieldCaptureValidationError,
    ],
    [
      { occupancyId: 'OCC-1', inspectionId: '../../OTHERDEPT/INS-1', idempotencyKey: 'k' },
      FieldCaptureValidationError,
    ],
    [
      { occupancyId: 'OCC-1', inspectionId: 'a/b', idempotencyKey: 'k' },
      FieldCaptureValidationError,
    ],
    [
      {
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        idempotencyKey: 'k',
        conductedAt: 'not-a-date',
      },
      FieldCaptureValidationError,
    ],
    [
      {
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        idempotencyKey: 'k',
        conductedAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
      FieldCaptureValidationError,
    ],
  ])('rejects %j', (body, errorClass) => {
    expect(() => parseFieldCapturePayload(body)).toThrow(errorClass);
  });

  it('accepts a conductedAt up to five minutes ahead (a phone clock running fast)', () => {
    const conductedAt = new Date(Date.now() + 60_000).toISOString();
    expect(
      parseFieldCapturePayload({
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        idempotencyKey: 'k',
        conductedAt,
      }).conductedAt,
    ).toBe(conductedAt);
  });

  it('accepts a past conductedAt and carries it through', () => {
    const conductedAt = '2026-09-10T12:00:00.000Z';
    const result = parseFieldCapturePayload({
      occupancyId: 'OCC-1',
      inspectionId: 'INS-1',
      idempotencyKey: 'idem-001',
      conductedAt,
    });
    expect(result.conductedAt).toBe(conductedAt);
  });

  it('rejects a malformed violation entry via the shared validateViolation (ValidationError, not FieldCaptureValidationError)', () => {
    expect(() =>
      parseFieldCapturePayload({
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        idempotencyKey: 'k',
        violations: [{ description: 'x', status: 'open' }],
      }),
    ).toThrow(ValidationError);
  });

  it('rejects more than 20 photoFilenames', () => {
    expect(() =>
      parseFieldCapturePayload({
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        idempotencyKey: 'k',
        photoFilenames: Array.from({ length: 21 }, (_, i) => `photo${i}.jpg`),
      }),
    ).toThrow(FieldCaptureValidationError);
  });
});
