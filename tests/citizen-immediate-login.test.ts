import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ find: vi.fn(), verify: vi.fn(), session: vi.fn(), access: vi.fn(), refresh: vi.fn() }));
vi.mock('@/repositories/user.repository', () => ({ UserRepository: class { findByEmail = mocks.find; } }));
vi.mock('@/repositories/token.repository', () => ({ TokenRepository: class { createRefreshToken = mocks.session; } }));
vi.mock('@/utils/password', () => ({ verifyPassword: mocks.verify, PasswordProcessingBusy: class extends Error {} }));
vi.mock('@/lib/jwt', () => ({ signAccessToken: mocks.access, signRefreshToken: mocks.refresh,
  TokenExpiry: { REFRESH_TOKEN_EXPIRES: '7d', ACCESS_TOKEN_EXPIRES: '15m' } }));
import { LoginCredentialsService } from '@/services/auth/login-credentials-service';
const citizen = { id: 'synthetic', email: 'citizen@example.test', name: 'Citizen', password: 'hash', role: 'USER', status: 'ACTIVE', emailVerified: null, department: null, isMainAdmin: false };
beforeEach(() => {
  vi.resetAllMocks(); mocks.find.mockResolvedValue(citizen); mocks.verify.mockResolvedValue(true);
  mocks.session.mockResolvedValue({ id: 'session' }); mocks.access.mockReturnValue('synthetic-access'); mocks.refresh.mockReturnValue('synthetic-refresh');
});
it('unverified citizens receive a bound session with only citizen permissions', async () => {
  const result = await LoginCredentialsService(' CITIZEN@example.test ', 'SyntheticOnly123');
  expect(result.code).toBe(200);
  expect(mocks.find).toHaveBeenCalledWith('citizen@example.test');
  expect(result.data?.user.permissions).toContain('incident:create-own');
  expect(result.data?.user.permissions).not.toContain('user:manage');
  expect(result.data?.user.permissions).not.toContain('incident:manage-all');
  expect(mocks.access).toHaveBeenCalledWith('synthetic', 'USER', '15m', 'session');
});
it.each(['ADMIN', 'DISPATCHER', 'RESPONDER', 'UNKNOWN'])('unverified %s cannot obtain a credential session', async role => {
  mocks.find.mockResolvedValue({ ...citizen, role, department: 'FIRE' });
  expect((await LoginCredentialsService(citizen.email, 'SyntheticOnly123')).code).toBe(403);
  expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.access).not.toHaveBeenCalled();
});
it.each([{ role: 'ADMIN', department: 'MAIN', isMainAdmin: true }, { role: 'ADMIN', department: 'FIRE' }, { role: 'DISPATCHER', department: 'POLICE' }])('verified operational assignments still work: %j', async assignment => {
  mocks.find.mockResolvedValue({ ...citizen, ...assignment, emailVerified: new Date() });
  expect((await LoginCredentialsService(citizen.email, 'SyntheticOnly123')).code).toBe(200);
});
it('inactive citizens and wrong credentials still cannot create sessions', async () => {
  mocks.find.mockResolvedValue({ ...citizen, status: 'INACTIVE' });
  expect((await LoginCredentialsService(citizen.email, 'SyntheticOnly123')).code).toBe(403);
  mocks.find.mockResolvedValue(citizen); mocks.verify.mockResolvedValue(false);
  expect((await LoginCredentialsService(citizen.email, 'wrong')).code).toBe(401);
  mocks.find.mockResolvedValue(null);
  expect((await LoginCredentialsService(citizen.email, 'wrong')).code).toBe(401);
  expect(mocks.session).not.toHaveBeenCalled();
});
it('verified operational accounts still need valid assignments', async () => {
  mocks.find.mockResolvedValue({ ...citizen, role: 'ADMIN', emailVerified: new Date() });
  expect((await LoginCredentialsService(citizen.email, 'SyntheticOnly123')).code).toBe(403);
  expect(mocks.session).not.toHaveBeenCalled();
});
it.each(['RESPONDER', 'UNKNOWN'])('verified %s cannot obtain a session', async role => {
  mocks.find.mockResolvedValue({ ...citizen, role, emailVerified: new Date(), department: 'FIRE' });
  expect((await LoginCredentialsService(citizen.email, 'SyntheticOnly123')).code).toBe(403);
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.access).not.toHaveBeenCalled();
});
