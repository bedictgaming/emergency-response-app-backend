import crypto from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  lookup: vi.fn(), create: vi.fn(), findToken: vi.fn(), transaction: vi.fn(),
  mail: vi.fn(), hash: vi.fn(), lock: vi.fn(), claim: vi.fn(), update: vi.fn(),
  identity: vi.fn(), intents: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ prisma: {
  user: { findUnique: mocks.lookup }, token: { create: mocks.create, findFirst: mocks.findToken },
  $transaction: mocks.transaction,
} }));
vi.mock('@/services/mail/mailer', () => ({ sendEmail: mocks.mail }));
vi.mock('@/config/env', () => ({ ENV: { FRONTEND_URL: 'https://account.example.test/' } }));
vi.mock('@/utils/password', () => ({ hashPassword: mocks.hash, PasswordProcessingBusy: class extends Error {} }));
import { RequestPasswordResetService, ResetPasswordService } from '@/services/auth/password-reset-service';
const token = 'a'.repeat(64);
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
beforeEach(() => {
  vi.resetAllMocks();
  mocks.hash.mockResolvedValue('derived-hash');
  mocks.transaction.mockImplementation(callback => callback({
    $queryRaw: mocks.lock, token: { updateMany: mocks.claim }, user: { update: mocks.update, findUnique: vi.fn(async () => ({ email: 'citizen@example.test' })) },
    authIdentity: { upsert: mocks.identity }, googleLinkIntent: { deleteMany: mocks.intents },
  }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
it('requests one 30-minute reset mail, stores only its digest and normalizes email', async () => {
  mocks.lookup.mockResolvedValue({ id: 'synthetic', email: 'citizen@example.test', status: 'ACTIVE', emailVerified: null });
  expect((await RequestPasswordResetService(' Citizen@Example.test ')).code).toBe(202);
  expect(mocks.lookup).toHaveBeenCalledWith({ where: { email: 'citizen@example.test' } });
  expect(mocks.mail).toHaveBeenCalledOnce();
  const action = mocks.mail.mock.calls[0][0].accountAction;
  const raw = new URL(action.url).searchParams.get('resetToken')!;
  expect(raw).toMatch(/^[a-f0-9]{64}$/);
  expect(mocks.create).toHaveBeenCalledWith({ data: {
    userId: 'synthetic', type: 'PASSWORD_RESET', token: digest(raw), expiresAt: expect.any(Date),
  } });
  const expiresAt = mocks.create.mock.calls[0][0].data.expiresAt;
  expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
  expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);
  expect(action).toMatchObject({ purpose: 'RESET_PASSWORD', expiresAt: expiresAt.toISOString() });
  expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(raw);
});
it('keeps unknown, inactive, database-failure and provider-failure responses indistinguishable', async () => {
  mocks.lookup.mockResolvedValue(null);
  const generic = await RequestPasswordResetService('missing@example.test');
  mocks.lookup.mockResolvedValue({ email: 'inactive@example.test', status: 'INACTIVE' });
  expect(await RequestPasswordResetService('inactive@example.test')).toEqual(generic);
  expect(mocks.mail).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  mocks.lookup.mockRejectedValue(new Error('private database error'));
  expect(await RequestPasswordResetService('missing@example.test')).toEqual(generic);
  mocks.lookup.mockResolvedValue({ id: 'synthetic', email: 'citizen@example.test', status: 'ACTIVE' });
  mocks.mail.mockRejectedValue(new Error('private provider error'));
  expect(await RequestPasswordResetService('citizen@example.test')).toEqual(generic);
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private');
});
it('rejects expired, used or revoked tokens before hashing or mutating', async () => {
  mocks.findToken.mockResolvedValue(null);
  expect((await ResetPasswordService(token, 'SyntheticOnly123')).code).toBe(400);
  expect(mocks.findToken).toHaveBeenCalledWith({ where: {
    token: digest(token), type: 'PASSWORD_RESET', consumedAt: null, revokedAt: null, expiresAt: { gt: expect.any(Date) },
  } });
  expect(mocks.hash).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
});
it('locks the user, claims once, changes only the password and revokes all old sessions', async () => {
  mocks.findToken.mockResolvedValue({ id: 'reset', userId: 'synthetic' });
  mocks.claim.mockResolvedValue({ count: 1 });
  expect((await ResetPasswordService(token, 'SyntheticOnly123')).code).toBe(200);
  expect(mocks.lock).toHaveBeenCalledOnce();
  expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.claim.mock.invocationCallOrder[0]);
  expect(mocks.claim.mock.calls[0][0]).toMatchObject({ where: { id: 'reset', type: 'PASSWORD_RESET', consumedAt: null, revokedAt: null, expiresAt: { gt: expect.any(Date) } }, data: { consumedAt: expect.any(Date) } });
  expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'synthetic' }, data: { password: 'derived-hash' } });
  expect(mocks.identity).toHaveBeenCalledWith(expect.objectContaining({ create: { userId: 'synthetic', provider: 'password', providerUserId: 'synthetic', email: 'citizen@example.test' } }));
  expect(mocks.intents).toHaveBeenCalledWith({ where: { userId: 'synthetic' } });
  expect(mocks.claim.mock.calls[1][0]).toEqual({ where: { userId: 'synthetic', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  expect(mocks.mail).not.toHaveBeenCalled();
});
it('a lost concurrent claim or intervening expiry never changes a password', async () => {
  mocks.findToken.mockResolvedValue({ id: 'reset', userId: 'synthetic' });
  mocks.claim.mockResolvedValue({ count: 0 });
  expect((await ResetPasswordService(token, 'SyntheticOnly123')).code).toBe(400);
  expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.claim).toHaveBeenCalledOnce();
});
it('only one of concurrent mocked claims can change the password', async () => {
  mocks.findToken.mockResolvedValue({ id: 'reset', userId: 'synthetic' });
  let claimed = false;
  mocks.claim.mockImplementation(async ({ data }) => {
    if (!data.consumedAt) return { count: 1 };
    if (claimed) return { count: 0 };
    claimed = true; return { count: 1 };
  });
  const results = await Promise.all([ResetPasswordService(token, 'SyntheticOnly123'), ResetPasswordService(token, 'SyntheticOnly456')]);
  expect(results.map(value => value.code).sort()).toEqual([200, 400]);
  expect(mocks.update).toHaveBeenCalledOnce();
});
