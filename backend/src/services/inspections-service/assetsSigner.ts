import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

// Pre-plan and inspection-photo files live in the platform-assets bucket and are read and
// written directly by the client through short-lived S3 presigned URLs. architecture.md §8
// describes CloudFront signed URLs, but N6.1 (U.S. residency, no global edge) forbids
// CloudFront repo-wide — infrastructure/test/residency-encryption.test.ts enforces it — so
// the URLs are regional S3 SigV4 presigned URLs instead, with the same 10-minute expiry and
// the same {deptId}/{entityType}/{entityId}/{filename} key scoping.
export interface AssetsConfig {
  readonly bucketName: string;
}

export function readAssetsConfig(env: NodeJS.ProcessEnv): AssetsConfig {
  const bucketName = env.PLATFORM_ASSETS_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('PLATFORM_ASSETS_BUCKET_NAME is required and was not set');
  }
  return { bucketName };
}

export interface AssetUrlRequest {
  readonly bucketName: string;
  readonly key: string;
  readonly method: 'GET' | 'PUT';
  readonly expiresInSeconds: number;
}

export type SignUrlFn = (request: AssetUrlRequest) => Promise<string>;

export const ASSET_URL_EXPIRY_SECONDS = 10 * 60;

let cachedS3Client: S3Client | undefined;

// Presigning is a local SigV4 computation with the Lambda role's credentials — no network
// call — so the client is not wrapped in X-Ray.
export const presignAssetUrl: SignUrlFn = (request) => {
  cachedS3Client ??= new S3Client({});
  const input = { Bucket: request.bucketName, Key: request.key };
  const command =
    request.method === 'PUT' ? new PutObjectCommand(input) : new GetObjectCommand(input);
  return getSignedUrl(cachedS3Client, command, { expiresIn: request.expiresInSeconds });
};

const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export function isSafeAssetFilename(filename: string): boolean {
  return SAFE_FILENAME_PATTERN.test(filename) && filename !== '.' && filename !== '..';
}

export function buildAssetKey(
  deptId: VerifiedDeptId,
  entityType: string,
  entityId: string,
  filename: string,
): string {
  return `${deptId}/${entityType}/${entityId}/${filename}`;
}

/** A presigned GET for an already-stored object (download/read path). */
export function createSignedAssetUrl(
  config: AssetsConfig,
  key: string,
  signer: SignUrlFn = presignAssetUrl,
): Promise<string> {
  return signer({
    bucketName: config.bucketName,
    key,
    method: 'GET',
    expiresInSeconds: ASSET_URL_EXPIRY_SECONDS,
  });
}

/** A presigned PUT the client uploads the file body to (upload path). */
export function createSignedUploadUrl(
  config: AssetsConfig,
  key: string,
  signer: SignUrlFn = presignAssetUrl,
): Promise<string> {
  return signer({
    bucketName: config.bucketName,
    key,
    method: 'PUT',
    expiresInSeconds: ASSET_URL_EXPIRY_SECONDS,
  });
}
