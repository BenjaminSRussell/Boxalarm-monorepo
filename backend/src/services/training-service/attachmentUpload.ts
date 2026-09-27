import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

// Files go to the platform-assets bucket through a short-lived regional S3 presigned PUT.
// architecture.md §8 describes CloudFront signed URLs, but N6.1 (U.S. residency, no global
// edge) forbids CloudFront repo-wide - infrastructure/test/residency-encryption.test.ts
// enforces it - so the CloudFront signer this module used could never be configured and
// every upload request failed. Same approach as inspections-service/assetsSigner.ts.
export interface AttachmentUploadConfig {
  readonly bucketName: string;
}

export function readAttachmentUploadConfig(
  env: NodeJS.ProcessEnv,
): Promise<AttachmentUploadConfig> {
  const bucketName = env.PLATFORM_ASSETS_BUCKET_NAME;
  if (!bucketName) {
    return Promise.reject(new Error('PLATFORM_ASSETS_BUCKET_NAME is required and was not set'));
  }
  return Promise.resolve({ bucketName });
}

/** Presigns one PUT; injectable so tests need no AWS credentials. */
export type PresignPutFn = (bucketName: string, key: string, expiresIn: number) => Promise<string>;

let cachedS3Client: S3Client | undefined;

// Presigning is a local SigV4 computation with the Lambda role's credentials - no network
// call - so the client is not wrapped in X-Ray.
export const presignPut: PresignPutFn = (bucketName, key, expiresIn) => {
  cachedS3Client ??= new S3Client({});
  return getSignedUrl(cachedS3Client, new PutObjectCommand({ Bucket: bucketName, Key: key }), {
    expiresIn,
  });
};

const UPLOAD_URL_EXPIRY_SECONDS = 10 * 60;

export interface CreateAttachmentUploadUrlParams {
  readonly deptId: VerifiedDeptId;
  readonly certId: string;
  readonly filename: string;
}

export interface AttachmentUpload {
  readonly attachmentS3Key: string;
  readonly uploadUrl: string;
}

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeFilename(filename: string): boolean {
  return SAFE_FILENAME.test(filename);
}

export async function createAttachmentUploadUrl(
  config: AttachmentUploadConfig,
  params: CreateAttachmentUploadUrlParams,
  presign: PresignPutFn = presignPut,
): Promise<AttachmentUpload> {
  if (!isSafeFilename(params.filename)) {
    throw new TypeError(
      `attachment filename must match ${SAFE_FILENAME}: received ${JSON.stringify(params.filename)}`,
    );
  }
  const attachmentS3Key = `${params.deptId}/CERTIFICATION/${params.certId}/${params.filename}`;
  const uploadUrl = await presign(config.bucketName, attachmentS3Key, UPLOAD_URL_EXPIRY_SECONDS);
  return { attachmentS3Key, uploadUrl };
}
