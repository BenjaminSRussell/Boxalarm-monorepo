import { describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createAttachmentUploadUrl, readAttachmentUploadConfig } from './attachmentUpload.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const config = { bucketName: 'boxalarm-dev-platform-assets' };

function fakePresign() {
  return vi.fn((bucket: string, key: string, expiresIn: number) =>
    Promise.resolve(
      `https://${bucket}.s3.us-east-1.amazonaws.com/${key}?X-Amz-Expires=${expiresIn}`,
    ),
  );
}

describe('readAttachmentUploadConfig', () => {
  it('reads the platform-assets bucket, never CloudFront (N6.1 forbids it)', async () => {
    await expect(
      readAttachmentUploadConfig({ PLATFORM_ASSETS_BUCKET_NAME: 'bucket-1' }),
    ).resolves.toEqual({ bucketName: 'bucket-1' });
  });

  it('fails when PLATFORM_ASSETS_BUCKET_NAME is unset', async () => {
    await expect(readAttachmentUploadConfig({})).rejects.toThrow('PLATFORM_ASSETS_BUCKET_NAME');
  });
});

describe('createAttachmentUploadUrl', () => {
  it('presigns a 10-minute PUT scoped to {deptId}/CERTIFICATION/{certId}/ (AC2)', async () => {
    const presign = fakePresign();
    const result = await createAttachmentUploadUrl(
      config,
      { deptId, certId: 'CERT-1', filename: 'cpr-card.pdf' },
      presign,
    );
    expect(result.attachmentS3Key).toBe('NICHOLS/CERTIFICATION/CERT-1/cpr-card.pdf');
    expect(presign).toHaveBeenCalledWith(
      'boxalarm-dev-platform-assets',
      'NICHOLS/CERTIFICATION/CERT-1/cpr-card.pdf',
      600,
    );
  });

  it.each([['sub/card.pdf'], ['../card.pdf'], ['card.pdf?x=1'], ['card.pdf#frag'], ['%2e%2e']])(
    'rejects an unsafe filename without presigning: %s',
    async (filename) => {
      const presign = fakePresign();
      await expect(
        createAttachmentUploadUrl(config, { deptId, certId: 'CERT-1', filename }, presign),
      ).rejects.toThrow(TypeError);
      expect(presign).not.toHaveBeenCalled();
    },
  );
});
