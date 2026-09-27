import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type FieldError,
  type GuardEvent,
  type ProblemResponse,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createAttachmentUploadUrl, readAttachmentUploadConfig } from '../attachmentUpload.js';
import { createCertification } from '../certificationRepository.js';
import { createDynamoClient, emitCertificationMetric } from '../dynamoClient.js';

interface ValidCreateCertificationBody {
  readonly certType: string;
  readonly issueDate: string;
  readonly expiryDate: string;
  readonly issuingAuthority: string;
  readonly attachmentFilename?: string;
}

type BodyValidationResult =
  { readonly value: ValidCreateCertificationBody } | { readonly errors: readonly FieldError[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function serverErrorProblem(traceId: string): ProblemResponse {
  return {
    statusCode: 500,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/internal-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
      traceId,
    }),
  };
}

function requireString(value: unknown, field: string, errors: FieldError[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({ field, detail: 'is required and must be a non-empty string' });
    return undefined;
  }
  return value;
}

function validateAttachment(raw: unknown, errors: FieldError[]): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    errors.push({ field: 'attachment', detail: 'must be an object' });
    return undefined;
  }
  return requireString((raw as { filename?: unknown }).filename, 'attachment.filename', errors);
}

function validateBody(raw: string | undefined): BodyValidationResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return { errors: [{ field: 'body', detail: 'must be valid JSON' }] };
  }

  const errors: FieldError[] = [];
  const certType = requireString(parsed.certType, 'certType', errors);
  const issueDate = requireString(parsed.issueDate, 'issueDate', errors);
  const expiryDate = requireString(parsed.expiryDate, 'expiryDate', errors);
  const issuingAuthority = requireString(parsed.issuingAuthority, 'issuingAuthority', errors);
  const attachmentFilename = validateAttachment(parsed.attachment, errors);

  if (issueDate !== undefined && !ISO_DATE.test(issueDate)) {
    errors.push({ field: 'issueDate', detail: 'must be an ISO date (YYYY-MM-DD)' });
  }
  if (expiryDate !== undefined && !ISO_DATE.test(expiryDate)) {
    errors.push({ field: 'expiryDate', detail: 'must be an ISO date (YYYY-MM-DD)' });
  }
  if (
    issueDate !== undefined &&
    expiryDate !== undefined &&
    ISO_DATE.test(issueDate) &&
    ISO_DATE.test(expiryDate) &&
    expiryDate < issueDate
  ) {
    errors.push({ field: 'expiryDate', detail: 'must not be before issueDate' });
  }

  if (errors.length > 0 || !certType || !issueDate || !expiryDate || !issuingAuthority) {
    return { errors };
  }
  return {
    value: {
      certType,
      issueDate,
      expiryDate,
      issuingAuthority,
      ...(attachmentFilename !== undefined ? { attachmentFilename } : {}),
    },
  };
}

async function createCertificationInner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, [{ field: 'memberId', detail: 'is required' }]);
  }

  const validated = validateBody(event.body);
  if ('errors' in validated) {
    return badRequestProblem(traceId, validated.errors);
  }
  const { value } = validated;
  const deptId = toVerifiedDeptId(principal);
  const certId = `CERT-${randomUUID()}`;

  let attachmentS3Key: string | null = null;
  let uploadUrl: string | undefined;
  if (value.attachmentFilename) {
    try {
      const config = await readAttachmentUploadConfig(process.env);
      const upload = await createAttachmentUploadUrl(config, {
        deptId,
        certId,
        filename: value.attachmentFilename,
      });
      attachmentS3Key = upload.attachmentS3Key;
      uploadUrl = upload.uploadUrl;
    } catch (error) {
      if (error instanceof TypeError) {
        console.error(
          JSON.stringify({
            event: 'certification.create.invalidAttachment',
            service: 'training',
            reason: error.constructor.name,
            correlationId: traceId,
            memberId,
          }),
        );
        return badRequestProblem(traceId, [
          { field: 'attachment.filename', detail: error.message },
        ]);
      }
      emitCertificationMetric('Failed');
      console.error(
        JSON.stringify({
          event: 'certification.create.attachmentConfigFailed',
          service: 'training',
          reason: error instanceof Error ? error.constructor.name : 'UnknownError',
          correlationId: traceId,
          memberId,
        }),
      );
      return serverErrorProblem(traceId);
    }
  }

  try {
    const client = createDynamoClient();
    const record = await createCertification(client, process.env, {
      deptId,
      memberId,
      certId,
      actorId: principal.sub,
      correlationId: traceId,
      certType: value.certType,
      issueDate: value.issueDate,
      expiryDate: value.expiryDate,
      issuingAuthority: value.issuingAuthority,
      attachmentS3Key,
      now: new Date(),
    });
    emitCertificationMetric('Created');
    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(uploadUrl ? { ...record, uploadUrl } : record),
    };
  } catch (error) {
    emitCertificationMetric('Failed');
    console.error(
      JSON.stringify({
        event: 'certification.create.unhandled',
        service: 'training',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        correlationId: traceId,
        memberId,
      }),
    );
    return serverErrorProblem(traceId);
  }
}

export const handler = withAuthorization(createCertificationInner, {
  actionType: 'Boxalarm::Action',
  actionId: 'CreateCertification',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
