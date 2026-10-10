import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  findProvider: vi.fn(), createLinkedUser: vi.fn(), findEmail: vi.fn(), lock: vi.fn(), currentUser: vi.fn(),
  binding: vi.fn(), createLink: vi.fn(), session: vi.fn(), revoke: vi.fn(), audit: vi.fn(), access: vi.fn(), refresh: vi.fn(), transaction: vi.fn(),
}));
vi.mock('@/repositories/oauth-account.repository', () => ({ OAuthAccountRepository: class { findByProvider = mocks.findProvider; createUserWithAccount = mocks.createLinkedUser; } }));
vi.mock('@/repositories/user.repository', () => ({ UserRepository: class { findByEmail = mocks.findEmail; } }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/jwt', () => ({ signAccessToken: mocks.access, signRefreshToken: mocks.refresh, TokenExpiry: { REFRESH_TOKEN_EXPIRES: '7d', ACCESS_TOKEN_EXPIRES: '15m' } }));
import { GoogleOAuthService } from '@/services/auth/google-oauth-service';

const profile = (overrides = {}) => ({ provider: 'google', id: 'google-subject', displayName: 'Citizen',
  emails: [{ value: 'citizen@gmail.com', verified: true }], _json: { email: 'citizen@gmail.com', email_verified: true }, ...overrides } as never);
const user = { id: 'citizen', name: 'Citizen', email: 'citizen@gmail.com', password: 'hash', role: 'USER', department: null, isMainAdmin: false, status: 'ACTIVE', emailVerified: new Date() };
const noWrites = () => {
  for (const fn of [mocks.createLinkedUser, mocks.createLink, mocks.session, mocks.audit, mocks.revoke, mocks.access, mocks.refresh]) expect(fn).not.toHaveBeenCalled();
};
describe('Google identity boundaries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findProvider.mockResolvedValue(null); mocks.findEmail.mockResolvedValue(null);
    mocks.createLinkedUser.mockResolvedValue({ userId: user.id }); mocks.currentUser.mockResolvedValue(user);
    mocks.binding.mockResolvedValue({ userId: user.id }); mocks.createLink.mockResolvedValue({ userId: user.id });
    mocks.session.mockResolvedValue({ id: 'session' }); mocks.access.mockReturnValue('access'); mocks.refresh.mockReturnValue('refresh');
    mocks.transaction.mockImplementation(callback => callback({ $queryRaw: mocks.lock, user: { findUnique: mocks.currentUser },
      authIdentity: { findUnique: mocks.binding, create: mocks.createLink }, token: { create: mocks.session, updateMany: mocks.revoke }, auditLog: { create: mocks.audit } }));
  });
  it('provisions a new verified Google user atomically with citizen privileges', async () => {
    expect((await GoogleOAuthService(profile())).code).toBe(200);
    expect(mocks.createLinkedUser).toHaveBeenCalledWith({ providerAccountId: 'google-subject', name: 'Citizen', email: user.email });
    expect(mocks.access).toHaveBeenCalledWith(user.id, 'USER', '15m', 'session');
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.session.mock.invocationCallOrder[0]);
  });
  it('links a verified existing password citizen without a second user', async () => {
    mocks.findEmail.mockResolvedValue(user); mocks.binding.mockResolvedValue(null);
    expect((await GoogleOAuthService(profile())).code).toBe(200);
    expect(mocks.createLinkedUser).not.toHaveBeenCalled();
    expect(mocks.createLink).toHaveBeenCalledWith({ data: { userId: user.id, provider: 'google', providerUserId: 'google-subject', email: user.email } });
    expect(mocks.audit).toHaveBeenCalledOnce(); expect(mocks.revoke).toHaveBeenCalledOnce();
    expect(mocks.access).toHaveBeenCalledWith(user.id, 'USER', '15m', 'session');
  });
  it.each(['ADMIN', 'DISPATCHER', 'RESPONDER'])('never implicitly links operational/retired role %s', async role => {
    mocks.findEmail.mockResolvedValue({ ...user, role, department: 'FIRE' });
    expect(await GoogleOAuthService(profile())).toMatchObject({ code: 409, errorCode: 'oauth_link_password_required' }); noWrites();
  });
  it('requires password confirmation for unverified local password accounts', async () => {
    mocks.findEmail.mockResolvedValue({ ...user, emailVerified: null });
    expect(await GoogleOAuthService(profile())).toMatchObject({ code: 409, message: 'Please log in with your password first, then link Google in Settings.' }); noWrites();
  });
  it.each([false, undefined, 'true'])('unverified Google claim %s never links an existing account', async email_verified => {
    mocks.findEmail.mockResolvedValue(user);
    expect(await GoogleOAuthService(profile({ _json: { email: user.email, email_verified } }))).toMatchObject({ code: 409, errorCode: 'oauth_link_password_required' }); noWrites();
  });
  it.each([false, undefined, 'true'])('unverified Google claim %s never creates a user', async email_verified => {
    expect((await GoogleOAuthService(profile({ _json: { email: user.email, email_verified } }))).code).toBe(403); noWrites();
  });
  it('rejects missing, mismatched, malformed and unverified parsed email claims', async () => {
    for (const overrides of [{ emails: [] }, { emails: [{ value: 'invalid', verified: true }] },
      { emails: [{ value: user.email, verified: false }] }, { _json: { email: 'other@gmail.com', email_verified: true } }])
      expect((await GoogleOAuthService(profile(overrides))).code).toBe(403);
    noWrites();
  });
  it('third-party verification alone does not establish current ownership', async () => {
    expect((await GoogleOAuthService(profile({ emails: [{ value: 'citizen@example.test', verified: true }],
      _json: { email: 'citizen@example.test', email_verified: true } }))).code).toBe(403); noWrites();
  });
  it('accepts verified Workspace with matching hd and rejects mismatch', async () => {
    expect((await GoogleOAuthService(profile({ emails: [{ value: 'citizen@example.test', verified: true }],
      _json: { email: 'citizen@example.test', email_verified: true, hd: 'example.test' } }))).code).toBe(200);
    expect((await GoogleOAuthService(profile({ emails: [{ value: 'citizen@example.test', verified: true }],
      _json: { email: 'citizen@example.test', email_verified: true, hd: 'other.test' } }))).code).toBe(403);
  });
  it('repeated Google sign-ins use one stable identity, even when email changes', async () => {
    mocks.findProvider.mockResolvedValue({ userId: user.id });
    for (let i = 0; i < 3; i++) expect((await GoogleOAuthService(profile({ emails: [], _json: {} }))).code).toBe(200);
    expect(mocks.findEmail).not.toHaveBeenCalled(); expect(mocks.createLinkedUser).not.toHaveBeenCalled(); expect(mocks.createLink).not.toHaveBeenCalled(); expect(mocks.session).toHaveBeenCalledTimes(3);
  });
  it('existing linked admins retain their current RBAC assignment', async () => {
    mocks.findProvider.mockResolvedValue({ userId: user.id }); mocks.currentUser.mockResolvedValue({ ...user, role: 'ADMIN', department: 'MAIN', isMainAdmin: true });
    const result = await GoogleOAuthService(profile());
    expect(result.code).toBe(200); if ('data' in result) expect(result.data?.user.permissions).toContain('incident:manage-all');
    expect(mocks.findEmail).not.toHaveBeenCalled(); expect(mocks.createLink).not.toHaveBeenCalled();
  });
  it.each([{ status: 'INACTIVE' }, { role: 'RESPONDER', department: 'FIRE' }, { role: 'ADMIN', department: null }])('rejects invalid existing assignment %j without tokens', async state => {
    mocks.findProvider.mockResolvedValue({ userId: user.id }); mocks.currentUser.mockResolvedValue({ ...user, ...state });
    expect((await GoogleOAuthService(profile())).code).toBe(403); noWrites();
  });
  it('does not issue after an unlink or cross-user binding wins the row lock', async () => {
    mocks.findProvider.mockResolvedValue({ userId: user.id });
    for (const binding of [null, { userId: 'other' }]) { mocks.binding.mockResolvedValue(binding); expect((await GoogleOAuthService(profile())).code).toBe(403); }
    noWrites();
  });
  it.each([{ emailVerified: null }, { email: 'changed@gmail.com' }, { role: 'ADMIN', department: 'FIRE' }])('rechecks auto-link eligibility after locking %j', async state => {
    mocks.findEmail.mockResolvedValue(user); mocks.currentUser.mockResolvedValue({ ...user, ...state }); mocks.binding.mockResolvedValue(null);
    expect((await GoogleOAuthService(profile())).code).toBe(403); noWrites();
  });
  it('does not replace a different Google method on the same user', async () => {
    mocks.findEmail.mockResolvedValue(user); mocks.binding.mockResolvedValueOnce(null).mockResolvedValueOnce({ userId: user.id, providerUserId: 'different' });
    expect((await GoogleOAuthService(profile())).code).toBe(403); noWrites();
  });
  it('fails closed on a concurrent unique collision; no email fallback', async () => {
    mocks.createLinkedUser.mockRejectedValue({ code: 'P2002' });
    expect((await GoogleOAuthService(profile())).code).toBe(409); expect(mocks.createLink).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
  });
  it('rejects invalid provider/subject before accessing the database', async () => {
    for (const value of [profile({ id: '' }), profile({ provider: 'other' }), undefined]) expect((await GoogleOAuthService(value as never)).code).toBe(400);
    expect(mocks.findProvider).not.toHaveBeenCalled(); noWrites();
  });
});
