import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), metadata: vi.fn(), sign: vi.fn(), revoke: vi.fn() }));
vi.mock('@/services/attachment/get-attachment-service', () => ({ GetAttachmentService: mocks.authorize }));
vi.mock('@/repositories/attachment.repository', () => ({ AttachmentRepository: class { findStorageMetadata = mocks.metadata; } }));
vi.mock('@/repositories/token.repository', () => ({ TokenRepository: class { revokeRefreshTokenByValue = mocks.revoke; } }));
vi.mock('@/lib/cloudinary', () => ({ createEvidenceDownloadUrl: mocks.sign }));
import { GetEvidenceDeliveryService } from '@/services/attachment/get-evidence-delivery-service';
import { LogoutService } from '@/services/auth/logout-service';

beforeEach(() => vi.resetAllMocks());
describe('evidence delivery service extraction', () => {
  it.each([401, 403, 404, 500])('preserves %s and never looks up storage or signs on denial', async code => {
    mocks.authorize.mockResolvedValue({ code, status: 'error', message: 'Denied' });
    expect(await GetEvidenceDeliveryService('proof', 'citizen', 'USER')).toEqual({ code, status: 'error', message: 'Denied' });
    expect(mocks.metadata).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it.each([null, { publicId: '', format: 'jpg' }, { publicId: 'private-id', format: null }])('does not sign unavailable metadata', async metadata => {
    mocks.authorize.mockResolvedValue({ code: 200, status: 'success', data: { attachment: {} } });
    mocks.metadata.mockResolvedValue(metadata);
    expect((await GetEvidenceDeliveryService('proof', 'citizen', 'USER')).code).toBe(404);
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it('authorizes before metadata, signs once, and returns only the unchanged 60-second delivery DTO', async () => {
    mocks.authorize.mockResolvedValue({ code: 200, status: 'success', data: { attachment: {} } });
    mocks.metadata.mockResolvedValue({ publicId: 'private-id', format: 'jpg' });
    mocks.sign.mockReturnValue('https://evidence.invalid/temporary');
    expect(await GetEvidenceDeliveryService('proof', 'citizen', 'USER')).toEqual({ code: 200, status: 'success', data: { url: 'https://evidence.invalid/temporary', expiresInSeconds: 60 } });
    expect(mocks.authorize).toHaveBeenCalledWith('proof', 'citizen', 'USER');
    expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.metadata.mock.invocationCallOrder[0]);
    expect(mocks.metadata.mock.invocationCallOrder[0]).toBeLessThan(mocks.sign.mock.invocationCallOrder[0]);
    expect(mocks.sign).toHaveBeenCalledTimes(1);
  });
  it('propagates storage failure without issuing a signed URL', async () => {
    mocks.authorize.mockResolvedValue({ code: 200, status: 'success', data: { attachment: {} } });
    mocks.metadata.mockRejectedValue(new Error('Synthetic storage outage'));
    await expect(GetEvidenceDeliveryService('proof', 'citizen', 'USER')).rejects.toThrow('Synthetic storage outage');
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
describe('logout service extraction', () => {
  it.each([undefined, null, 1, {}])('keeps no-token logout side-effect-free', async token => {
    await LogoutService(token);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it('revokes the supplied refresh value once', async () => {
    await LogoutService('synthetic-refresh');
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith('synthetic-refresh');
  });
  it('propagates revocation failure rather than acknowledging logout', async () => {
    mocks.revoke.mockRejectedValue(new Error('Synthetic persistence outage'));
    await expect(LogoutService('synthetic-refresh')).rejects.toThrow('Synthetic persistence outage');
  });
});
