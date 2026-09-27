import { describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createDefectPhotoUploadUrl,
  readDefectPhotoUploadConfig,
  resignDefectPhotoUploadUrl,
} from './defectPhotoUpload.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const config = { bucketName: 'boxalarm-dev-platform-assets' };

function fakePresign() {
  return vi.fn((bucket: string, key: string, expiresIn: number) =>
    Promise.resolve(
      `https://${bucket}.s3.us-east-1.amazonaws.com/${key}?X-Amz-Expires=${expiresIn}`,
    ),
  );
}

describe('readDefectPhotoUploadConfig', () => {
  it('reads the platform-assets bucket, never CloudFront (N6.1 forbids it)', async () => {
    await expect(
      readDefectPhotoUploadConfig({ PLATFORM_ASSETS_BUCKET_NAME: 'bucket-1' }),
    ).resolves.toEqual({ bucketName: 'bucket-1' });
  });

  it('fails when PLATFORM_ASSETS_BUCKET_NAME is unset', async () => {
    await expect(readDefectPhotoUploadConfig({})).rejects.toThrow('PLATFORM_ASSETS_BUCKET_NAME');
  });
});

describe('createDefectPhotoUploadUrl', () => {
  it('presigns a 10-minute PUT for {deptId}/defect/{defectId}/{filename}', async () => {
    const presign = fakePresign();
    const result = await createDefectPhotoUploadUrl(
      config,
      { deptId, defectId: 'DEF-0033', filename: 'photo.jpg' },
      presign,
    );
    expect(result.photoS3Key).toBe('NICHOLS/defect/DEF-0033/photo.jpg');
    expect(presign).toHaveBeenCalledWith(
      'boxalarm-dev-platform-assets',
      'NICHOLS/defect/DEF-0033/photo.jpg',
      600,
    );
    expect(result.uploadUrl).toContain('boxalarm-dev-platform-assets.s3.us-east-1.amazonaws.com');
  });

  it.each([['sub/photo.jpg'], ['../photo.jpg']])(
    'rejects a prefix-escaping filename without presigning: %s',
    async (filename) => {
      const presign = fakePresign();
      await expect(
        createDefectPhotoUploadUrl(config, { deptId, defectId: 'DEF-0033', filename }, presign),
      ).rejects.toThrow(TypeError);
      expect(presign).not.toHaveBeenCalled();
    },
  );

  it.each([['photo.html'], ['photo.svg'], ['photo.js'], ['photo.exe'], ['photo']])(
    'rejects a disallowed or missing file extension: %s',
    async (filename) => {
      await expect(
        createDefectPhotoUploadUrl(
          config,
          { deptId, defectId: 'DEF-0033', filename },
          fakePresign(),
        ),
      ).rejects.toThrow(TypeError);
    },
  );

  it.each([['photo.jpg'], ['photo.JPEG'], ['photo.png'], ['photo.heic'], ['photo.webp']])(
    'accepts an allowed image extension regardless of case: %s',
    async (filename) => {
      await expect(
        createDefectPhotoUploadUrl(
          config,
          { deptId, defectId: 'DEF-0033', filename },
          fakePresign(),
        ),
      ).resolves.toMatchObject({ photoS3Key: `NICHOLS/defect/DEF-0033/${filename}` });
    },
  );
});

describe('resignDefectPhotoUploadUrl', () => {
  it('refuses a stored key outside the department defect prefix', async () => {
    const presign = vi.fn().mockResolvedValue('https://signed');

    await expect(
      resignDefectPhotoUploadUrl(config, deptId, 'OTHER/defect/D-1/p.jpg', presign),
    ).rejects.toThrow(TypeError);
    await expect(
      resignDefectPhotoUploadUrl(config, deptId, 'NICHOLS/defect/../CERTIFICATION/x', presign),
    ).rejects.toThrow(TypeError);
    await expect(
      resignDefectPhotoUploadUrl(config, deptId, 'NICHOLS/defect/D-1/p.jpg', presign),
    ).resolves.toBe('https://signed');
    expect(presign).toHaveBeenCalledWith(
      'boxalarm-dev-platform-assets',
      'NICHOLS/defect/D-1/p.jpg',
      600,
    );
  });
});
