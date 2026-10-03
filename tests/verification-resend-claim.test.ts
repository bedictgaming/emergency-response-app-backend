import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ tx: vi.fn(), lock: vi.fn(), user: vi.fn(), find: vi.fn(), create: vi.fn(), revoke: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.tx } }));
import { TokenRepository } from '@/repositories/token.repository';
const now = new Date('2026-10-03T08:00:00Z');
beforeEach(() => {
  vi.resetAllMocks();
  mocks.tx.mockImplementation(callback => callback({ $queryRaw: mocks.lock, user: { findUnique: mocks.user }, token: { findFirst: mocks.find, create: mocks.create, updateMany: mocks.revoke } }));
  mocks.user.mockResolvedValue({ id: 'user', status: 'ACTIVE', emailVerified: null });
  mocks.create.mockImplementation(({ data }) => Promise.resolve(data));
});
it('claims a persisted cooldown under a user lock without revoking a valid link', async () => {
  const valid = { token: 'original-link', createdAt: new Date(now.getTime() - 120000), expiresAt: new Date(now.getTime() + 600000) };
  mocks.find.mockResolvedValueOnce(valid).mockResolvedValueOnce(valid);
  const claim = await new TokenRepository().claimVerificationResend('user', now);
  expect(claim?.token.token).toBe('original-link'); expect(mocks.revoke).not.toHaveBeenCalled();
  expect(mocks.create.mock.calls[0][0].data).toMatchObject({ expiresAt: now, revokedAt: now, type: 'EMAIL_VERIFY' });
  expect(mocks.lock.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
});
it('denies a recent resend and inactive/verified accounts without token writes', async () => {
  mocks.find.mockResolvedValue({ createdAt: new Date(now.getTime() - 30000) });
  expect(await new TokenRepository().claimVerificationResend('user', now)).toBeNull();
  mocks.user.mockResolvedValue({ status: 'INACTIVE', emailVerified: null });
  expect(await new TokenRepository().claimVerificationResend('user', now)).toBeNull();
  mocks.user.mockResolvedValue({ status: 'ACTIVE', emailVerified: now });
  expect(await new TokenRepository().claimVerificationResend('user', now)).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
});
it.each(['missing', 'expired'])('recovers a %s token with a fresh 24-hour link', async scenario => {
  mocks.find.mockResolvedValueOnce(scenario === 'missing' ? null : { createdAt: new Date(now.getTime() - 86400000) }).mockResolvedValueOnce(null);
  const claim = await new TokenRepository().claimVerificationResend('user', now);
  expect(claim?.token.expiresAt.getTime()).toBe(now.getTime() + 86400000);
  expect(mocks.revoke).toHaveBeenCalled(); expect(mocks.create.mock.calls[0][0].data).not.toHaveProperty('revokedAt');
});
