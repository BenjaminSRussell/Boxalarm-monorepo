import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readApparatusTableConfig } from './dynamoClient.js';
import { createDefectPhotoUploadUrl, readDefectPhotoUploadConfig } from './defectPhotoUpload.js';
import {
  ApparatusNotFoundError,
  DuplicateDefectReportError,
  createDefect,
  getDefectByIdempotencyKey,
  type DefectRecord,
  type DefectSeverity,
} from './defectRepository.js';
import { apparatusNotFoundProblem, validationProblem } from './problemDetails.js';
import type { ValidationFieldError } from './problemDetails.js';
import {
  ServiceStatusConflictError,
  setServiceStatus,
  type SetServiceStatusInput,
} from './repository.js';

const VALID_SEVERITIES: readonly DefectSeverity[] = ['MINOR', 'MAJOR', 'OUT_OF_SERVICE'];

type SetServiceStatusFn = (
  client: DynamoDBDocumentClient,
  tableName: string,
  input: SetServiceStatusInput,
) => Promise<void>;

interface ReportDefectDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now: () => number;
  readonly newDefectId: () => string;
  readonly setServiceStatus: SetServiceStatusFn;
}

interface ValidatedDefectBody {
  readonly description: string;
  readonly severity: DefectSeverity;
  readonly photoS3Key?: string;
  readonly photoFilename?: string;
  readonly clientMutationId?: string;
}

function emitDefectMetric(name: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/apparatus-service',
            Dimensions: [[]],
            Metrics: [{ Name: name, Unit: 'Count' }],
          },
        ],
      },
      [name]: 1,
    }),
  );
}

/**
 * A client-supplied (already-uploaded) photoS3Key must live under the caller's own
 * department prefix. Without this check a client could reference another department's
 * object key, which would then be persisted on the DEFECT record and propagated into the
 * apparatus.defect.reported outbox payload — a cross-tenant reference leak that breaks the
 * "{deptId} scopes everything" invariant this codebase otherwise enforces via
 * buildDeptScopedPk on every partition key.
 */
function isDeptScopedPhotoKey(deptId: VerifiedDeptId, key: string): boolean {
  const prefix = `${deptId}/defect/`;
  return key.startsWith(prefix) && !key.includes('..') && !key.includes('//');
}

function validateBody(
  body: Record<string, unknown>,
  deptId: VerifiedDeptId,
):
  | { readonly ok: true; readonly value: ValidatedDefectBody }
  | { readonly ok: false; readonly errors: readonly ValidationFieldError[] } {
  const errors: ValidationFieldError[] = [];

  if (typeof body.description !== 'string' || body.description.trim().length === 0) {
    errors.push({ field: 'description', message: 'is required and must be a non-empty string' });
  }
  if (
    typeof body.severity !== 'string' ||
    !VALID_SEVERITIES.includes(body.severity as DefectSeverity)
  ) {
    errors.push({
      field: 'severity',
      message: 'must be one of MINOR, MAJOR, OUT_OF_SERVICE',
    });
  }

  let photoS3Key: string | undefined;
  if (body.photoS3Key !== undefined) {
    if (typeof body.photoS3Key !== 'string' || body.photoS3Key.length === 0) {
      errors.push({ field: 'photoS3Key', message: 'must be a non-empty string when provided' });
    } else if (!isDeptScopedPhotoKey(deptId, body.photoS3Key)) {
      errors.push({
        field: 'photoS3Key',
        message: `must be scoped to the caller's department (expected prefix "${deptId}/defect/")`,
      });
    } else {
      photoS3Key = body.photoS3Key;
    }
  }

  let photoFilename: string | undefined;
  if (body.photo !== undefined) {
    if (typeof body.photo !== 'object' || body.photo === null || Array.isArray(body.photo)) {
      errors.push({ field: 'photo', message: 'must be an object' });
    } else {
      const filename = (body.photo as { filename?: unknown }).filename;
      if (typeof filename !== 'string' || filename.length === 0) {
        errors.push({
          field: 'photo.filename',
          message: 'is required and must be a non-empty string',
        });
      } else {
        photoFilename = filename;
      }
    }
  }

  const rawMutationId = body.clientMutationId ?? body.idempotencyKey;
  let clientMutationId: string | undefined;
  if (rawMutationId !== undefined) {
    if (typeof rawMutationId !== 'string' || rawMutationId.trim().length === 0) {
      errors.push({
        field: 'clientMutationId',
        message: 'must be a non-empty string when provided',
      });
    } else {
      clientMutationId = rawMutationId.trim();
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      description: (body.description as string).trim(),
      severity: body.severity as DefectSeverity,
      ...(photoS3Key !== undefined ? { photoS3Key } : {}),
      ...(photoFilename !== undefined ? { photoFilename } : {}),
      ...(clientMutationId !== undefined ? { clientMutationId } : {}),
    },
  };
}

function toResponseBody(defect: DefectRecord, uploadUrl?: string): Record<string, unknown> {
  return {
    defectId: defect.defectId,
    apparatusId: defect.apparatusId,
    unitId: defect.unitId,
    description: defect.description,
    severity: defect.severity,
    status: defect.status,
    reportedBy: defect.reportedBy,
    reportedAt: defect.reportedAt,
    photoS3Key: defect.photoS3Key,
    outOfService: defect.outOfService,
    ...(uploadUrl !== undefined ? { uploadUrl } : {}),
  };
}

async function reportDefect(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: ReportDefectDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const unitId = event.pathParameters?.unitId;
  if (!unitId) {
    return apparatusNotFoundProblem(traceId);
  }
  const deptId = toVerifiedDeptId(principal);

  let rawBody: Record<string, unknown>;
  try {
    rawBody = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'apparatus.defect.validation_failed',
        reason: 'MalformedJson',
        correlationId: traceId,
        deptId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return validationProblem(traceId, [{ field: 'body', message: 'must be valid JSON' }]);
  }

  const validation = validateBody(rawBody, deptId);
  if (!validation.ok) {
    return validationProblem(traceId, validation.errors);
  }
  const { value } = validation;

  if (value.clientMutationId) {
    try {
      const existing = await getDefectByIdempotencyKey(deps.client, deps.tableName, {
        deptId,
        unitId,
        clientMutationId: value.clientMutationId,
      });
      if (existing) {
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(toResponseBody(existing)),
        };
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'apparatus.defect.idempotency_lookup_failed',
          correlationId: traceId,
          deptId,
          unitId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      emitDefectMetric('DefectReportFailed');
      throw error;
    }
  }

  const defectId = deps.newDefectId();
  let photoS3Key = value.photoS3Key ?? null;
  let uploadUrl: string | undefined;

  if (value.photoFilename) {
    try {
      const config = await readDefectPhotoUploadConfig(process.env);
      const upload = await createDefectPhotoUploadUrl(config, {
        deptId,
        defectId,
        filename: value.photoFilename,
      });
      photoS3Key = upload.photoS3Key;
      uploadUrl = upload.uploadUrl;
    } catch (error) {
      if (error instanceof TypeError) {
        console.error(
          JSON.stringify({
            event: 'apparatus.defect.invalidPhotoFilename',
            correlationId: traceId,
            deptId,
            unitId,
            message: error.message,
          }),
        );
        return validationProblem(traceId, [{ field: 'photo.filename', message: error.message }]);
      }
      console.error(
        JSON.stringify({
          event: 'apparatus.defect.photoConfigFailed',
          correlationId: traceId,
          deptId,
          unitId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      emitDefectMetric('DefectReportFailed');
      throw error;
    }
  }

  let defect: DefectRecord;
  try {
    defect = await createDefect(deps.client, deps.tableName, {
      deptId,
      unitId,
      description: value.description,
      severity: value.severity,
      reportedByMemberId: principal.sub,
      correlationId: traceId,
      photoS3Key,
      ...(value.clientMutationId ? { clientMutationId: value.clientMutationId } : {}),
      defectId,
      now: deps.now,
    });
  } catch (error) {
    if (error instanceof ApparatusNotFoundError) {
      return apparatusNotFoundProblem(traceId);
    }
    if (error instanceof DuplicateDefectReportError && value.clientMutationId) {
      const existing = await getDefectByIdempotencyKey(deps.client, deps.tableName, {
        deptId,
        unitId,
        clientMutationId: value.clientMutationId,
      });
      if (existing) {
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(toResponseBody(existing)),
        };
      }
    }
    console.error(
      JSON.stringify({
        event: 'apparatus.defect.create_failed',
        correlationId: traceId,
        deptId,
        unitId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    emitDefectMetric('DefectReportFailed');
    throw error;
  }

  if (value.severity === 'OUT_OF_SERVICE') {
    try {
      await deps.setServiceStatus(deps.client, deps.tableName, {
        deptId,
        unitId,
        status: 'OUT_OF_SERVICE',
        reason: value.description,
      });
    } catch (error) {
      if (!(error instanceof ServiceStatusConflictError)) {
        console.error(
          JSON.stringify({
            event: 'apparatus.defect.oos_transition_failed',
            correlationId: traceId,
            deptId,
            unitId,
            defectId: defect.defectId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        emitDefectMetric('DefectOosTransitionFailed');
      }
      // Conflict = already OOS; defect + outbox already committed. Do not fail the report.
    }
  }

  emitDefectMetric('DefectReported');
  return {
    statusCode: 201,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toResponseBody(defect, uploadUrl)),
  };
}

interface ReportDefectOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly now?: () => number;
  readonly newDefectId?: () => string;
  readonly setServiceStatus?: SetServiceStatusFn;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: ReportDefectOverrides): ReportDefectDeps {
  return {
    client: overrides.client ?? createDynamoClient(process.env),
    tableName: overrides.tableName ?? readApparatusTableConfig(process.env).tableName,
    now: overrides.now ?? (() => Math.floor(Date.now() / 1000)),
    newDefectId: overrides.newDefectId ?? (() => `DEF-${randomUUID()}`),
    setServiceStatus: overrides.setServiceStatus ?? setServiceStatus,
  };
}

export function createReportDefectHandler(
  overrides: ReportDefectOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => reportDefect(event, principal, resolveDeps(overrides)),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ReportDefect',
      resourceType: 'Boxalarm::Apparatus',
      resourceId: (event) => event.pathParameters?.unitId ?? '',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createReportDefectHandler();
