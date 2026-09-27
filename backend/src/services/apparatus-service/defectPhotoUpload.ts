import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

// Files go to the platform-assets bucket through a short-lived regional S3 presigned PUT.
// architecture.md §8 describes CloudFront signed URLs, but N6.1 (U.S. residency, no global
// edge) forbids CloudFront repo-wide - infrastructure/test/residency-encryption.test.ts
// enforces it - so the CloudFront signer this module used could never be configured and
// every upload request failed. Same approach as inspections-service/assetsSigner.ts.
export interface DefectPhotoUploadConfig {
  readonly bucketName: string;
}

export function readDefectPhotoUploadConfig(
  env: NodeJS.ProcessEnv,
): Promise<DefectPhotoUploadConfig> {
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

export interface CreateDefectPhotoUploadUrlParams {
  readonly deptId: VerifiedDeptId;
  readonly defectId: string;
  readonly filename: string;
}

export interface DefectPhotoUpload {
  readonly photoS3Key: string;
  readonly uploadUrl: string;
}

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The presigned PUT does not constrain the Content-Type or size of what the client sends,
// so this extension allowlist keeps a defect "photo" from being an .html/.svg/.js payload
// that a later presigned GET would hand back to a browser (stored-content/XSS risk).
const ALLOWED_PHOTO_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'heic',
  'heif',
  'webp',
]);

function isSafeFilename(filename: string): boolean {
  if (!SAFE_FILENAME.test(filename)) {
    return false;
  }
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return false;
  }
  return ALLOWED_PHOTO_EXTENSIONS.has(filename.slice(lastDot + 1).toLowerCase());
}

export async function createDefectPhotoUploadUrl(
  config: DefectPhotoUploadConfig,
  params: CreateDefectPhotoUploadUrlParams,
  presign: PresignPutFn = presignPut,
): Promise<DefectPhotoUpload> {
  if (!isSafeFilename(params.filename)) {
    throw new TypeError(
      `photo filename must match ${SAFE_FILENAME} with an allowed image extension ` +
        `(${[...ALLOWED_PHOTO_EXTENSIONS].join(', ')}): received ${JSON.stringify(params.filename)}`,
    );
  }
  const photoS3Key = `${params.deptId}/defect/${params.defectId}/${params.filename}`;
  const uploadUrl = await presign(config.bucketName, photoS3Key, UPLOAD_URL_EXPIRY_SECONDS);
  return { photoS3Key, uploadUrl };
}
