import { afterEach, describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildAssetKey,
  createSignedAssetUrl,
  createSignedUploadUrl,
  isSafeAssetFilename,
  presignAssetUrl,
  readAssetsConfig,
} from './assetsSigner.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const CONFIG = { bucketName: 'boxalarm-dev-platform-assets' };

describe('readAssetsConfig', () => {
  it('reads the bucket name', () => {
    expect(readAssetsConfig({ PLATFORM_ASSETS_BUCKET_NAME: 'bucket' })).toEqual({
      bucketName: 'bucket',
    });
  });

  it('throws when PLATFORM_ASSETS_BUCKET_NAME is not set', () => {
    expect(() => readAssetsConfig({})).toThrow(
      'PLATFORM_ASSETS_BUCKET_NAME is required and was not set',
    );
  });
});

describe('isSafeAssetFilename', () => {
  it('accepts plain filenames', () => {
    expect(isSafeAssetFilename('diagram.pdf')).toBe(true);
    expect(isSafeAssetFilename('photo_1-final.JPG')).toBe(true);
  });

  it.each(['../../OTHERDEPT/diagram.pdf', 'a/b.pdf', '..', '.', '', 'a'.repeat(201)])(
    'rejects unsafe filename %s',
    (filename) => {
      expect(isSafeAssetFilename(filename)).toBe(false);
    },
  );
});

describe('buildAssetKey', () => {
  it('builds the {deptId}/{entityType}/{entityId}/{filename} key per AC2/AC3', () => {
    expect(buildAssetKey(DEPT_ID, 'PRE_PLAN', 'PP-0044', 'diagram.pdf')).toBe(
      'NICHOLS/PRE_PLAN/PP-0044/diagram.pdf',
    );
    expect(buildAssetKey(DEPT_ID, 'INSPECTION_RECORD', 'INS-1', 'photo.jpg')).toBe(
      'NICHOLS/INSPECTION_RECORD/INS-1/photo.jpg',
    );
  });
});

describe('createSignedUploadUrl', () => {
  it('presigns a PUT for the exact key with a 10-minute expiry', async () => {
    const signer = vi.fn().mockResolvedValue('https://signed.example.com/x');
    const url = await createSignedUploadUrl(CONFIG, 'NICHOLS/PRE_PLAN/PP-0044/diagram.pdf', signer);

    expect(url).toBe('https://signed.example.com/x');
    expect(signer).toHaveBeenCalledWith({
      bucketName: 'boxalarm-dev-platform-assets',
      key: 'NICHOLS/PRE_PLAN/PP-0044/diagram.pdf',
      method: 'PUT',
      expiresInSeconds: 600,
    });
  });
});

describe('createSignedAssetUrl', () => {
  it('presigns a GET for an already-stored key (read path)', async () => {
    const signer = vi.fn().mockResolvedValue('https://signed.example.com/read');
    const url = await createSignedAssetUrl(CONFIG, 'NICHOLS/PRE_PLAN/PP-1/diagram.pdf', signer);
    expect(url).toBe('https://signed.example.com/read');
    expect(signer).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', key: 'NICHOLS/PRE_PLAN/PP-1/diagram.pdf' }),
    );
  });
});

describe('presignAssetUrl (real SigV4 presigner, no network)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it.each([
    ['PUT', 'PutObject'],
    ['GET', 'GetObject'],
  ] as const)(
    'produces a regional S3 %s URL scoped to the key with a 600s expiry',
    async (method, operation) => {
      process.env.AWS_REGION = 'us-east-1';
      process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      const url = new URL(
        await presignAssetUrl({
          bucketName: 'boxalarm-dev-platform-assets',
          key: 'NICHOLS/PRE_PLAN/PP-1/diagram.pdf',
          method,
          expiresInSeconds: 600,
        }),
      );
      expect(url.hostname).toBe('boxalarm-dev-platform-assets.s3.us-east-1.amazonaws.com');
      expect(url.pathname).toBe('/NICHOLS/PRE_PLAN/PP-1/diagram.pdf');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(url.searchParams.get('x-id')).toBe(operation);
      expect(url.hostname).not.toContain('cloudfront');
    },
  );
});
