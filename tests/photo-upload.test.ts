import { afterEach, describe, expect, it, vi } from 'vitest';
import cloudinary, { generateUploadSignature, verifyUploadedAsset } from '@/lib/cloudinary';
import { ENV } from '@/config/env';

afterEach(() => vi.restoreAllMocks());
describe('proof upload protocol', () => {
  it('signs exactly the fields submitted by the browser and disallows overwrite', () => {
    const result = generateUploadSignature('reporter');
    const expected = cloudinary.utils.api_sign_request({ timestamp: result.timestamp, folder: result.folder, public_id: result.publicId, overwrite: false, type: 'authenticated', allowed_formats: 'jpg,jpeg,png,webp,heic' }, ENV.CLOUDINARY.API_SECRET);
    expect(result.signature).toBe(expected);
    expect(result.overwrite).toBe(false);
    expect(result.type).toBe('authenticated');
    expect(result.public_id).toBe(result.publicId);
    expect(result.allowed_formats).toBe('jpg,jpeg,png,webp,heic');
    expect(result).not.toHaveProperty('resource_type');
  });
  it('rejects evidence owned by another citizen', async () => {
    vi.spyOn(cloudinary.api, 'resource').mockResolvedValue({ public_id: 'emergency-incidents/other/photo', format: 'jpg', bytes: 100 } as never);
    await expect(verifyUploadedAsset('photo', 'reporter')).rejects.toThrow('does not belong');
  });
  it('rejects oversized assets even if client validation is bypassed', async () => {
    vi.spyOn(cloudinary.api, 'resource').mockResolvedValue({ public_id: 'emergency-incidents/reporter/photo', format: 'jpg', bytes: 9 * 1024 * 1024 } as never);
    await expect(verifyUploadedAsset('photo', 'reporter')).rejects.toThrow('5 MB');
  });
  it('retries a transient Cloudinary 404 immediately after upload', async () => {
    vi.useFakeTimers();
    const resource = vi.spyOn(cloudinary.api, 'resource')
      .mockRejectedValueOnce({ error: { http_code: 404, message: 'Resource not found' } })
      .mockResolvedValue({
        public_id: 'emergency-incidents/reporter/photo',
        secure_url: 'https://example.test/photo.jpg',
        format: 'jpg',
        bytes: 100,
        width: 20,
        height: 20,
      } as never);

    const verification = verifyUploadedAsset('emergency-incidents/reporter/photo', 'reporter');
    await vi.runAllTimersAsync();

    await expect(verification).resolves.toMatchObject({
      publicId: 'emergency-incidents/reporter/photo',
      bytes: 100,
    });
    expect(resource).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
