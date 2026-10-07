import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  findUser: vi.fn(), findToken: vi.fn(), verify: vi.fn(), transaction: vi.fn(),
  lock: vi.fn(), claim: vi.fn(), create: vi.fn(), access: vi.fn(), refresh: vi.fn(),
}));
vi.mock('@/repositories/user.repository', () => ({ UserRepository: class { findById = mocks.findUser; } }));
vi.mock('@/repositories/token.repository', () => ({ TokenRepository: class { findActiveRefreshToken = mocks.findToken; } }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/jwt', () => ({ verifyRefreshToken: mocks.verify, signAccessToken: mocks.access, signRefreshToken: mocks.refresh,
  TokenExpiry: { REFRESH_TOKEN_EXPIRES: '7d', ACCESS_TOKEN_EXPIRES: '15m' } }));
import { RefreshTokenService } from '@/services/auth/refresh-token-service';
const citizen = { id: 'synthetic', role: 'USER', emailVerified: null, status: 'ACTIVE', department: null, isMainAdmin: false };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockReturnValue({ sub: citizen.id });
  mocks.findUser.mockResolvedValue(citizen); mocks.findToken.mockResolvedValue({ id: 'old-session' });
  mocks.claim.mockResolvedValue({ count: 1 }); mocks.create.mockResolvedValue({ id: 'new-session' });
  mocks.access.mockReturnValue('synthetic-access'); mocks.refresh.mockReturnValue('synthetic-refresh');
  mocks.transaction.mockImplementation(callback => callback({ $queryRaw: mocks.lock, token: { updateMany: mocks.claim, create: mocks.create } }));
});
it('unverified citizens can rotate an active session without changing email ownership or permissions', async () => {
  const result = await RefreshTokenService('synthetic-old-refresh');
  expect(result.code).toBe(200); expect(result.data?.user.permissions).toContain('incident:create-own');
  expect(result.data?.user.permissions).not.toContain('user:manage');
  expect(mocks.access).toHaveBeenCalledWith(citizen.id, 'USER', '15m', 'new-session');
  expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.claim.mock.invocationCallOrder[0]);
  expect(mocks.claim).toHaveBeenCalledWith({ where: { id: 'old-session', consumedAt: null, revokedAt: null, expiresAt: { gt: expect.any(Date) } }, data: { consumedAt: expect.any(Date) } });
});
it.each(['ADMIN', 'DISPATCHER', 'RESPONDER', 'UNKNOWN'])('unverified %s cannot renew', async role => {
  mocks.findUser.mockResolvedValue({ ...citizen, role, department: 'FIRE' });
  expect((await RefreshTokenService('synthetic-old-refresh')).code).toBe(403);
  expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.access).not.toHaveBeenCalled();
});
it('inactive citizens cannot renew', async () => {
  mocks.findUser.mockResolvedValue({ ...citizen, status: 'INACTIVE' });
  expect((await RefreshTokenService('synthetic-old-refresh')).code).toBe(403);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it('expired, revoked and lost concurrent sessions cannot renew', async () => {
  mocks.findToken.mockResolvedValue(null);
  expect((await RefreshTokenService('synthetic-old-refresh')).code).toBe(401);
  expect(mocks.transaction).not.toHaveBeenCalled();
  mocks.findToken.mockResolvedValue({ id: 'old-session' }); mocks.claim.mockResolvedValue({ count: 0 });
  expect((await RefreshTokenService('synthetic-old-refresh')).code).toBe(401);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.access).not.toHaveBeenCalled();
});
it('verified staff still need valid assignments for renewal', async () => {
  mocks.findUser.mockResolvedValue({ ...citizen, role: 'ADMIN', emailVerified: new Date() });
  expect((await RefreshTokenService('synthetic-old-refresh')).code).toBe(403);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
