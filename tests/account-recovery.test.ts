import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ find: vi.fn(), claim: vi.fn(), send: vi.fn(), create: vi.fn(), token: vi.fn() }));
vi.mock('@/repositories/user.repository', () => ({ UserRepository: class { findByEmail = mocks.find; create = mocks.create; } }));
vi.mock('@/repositories/token.repository', () => ({ TokenRepository: class { claimVerificationResend = mocks.claim; createEmailVerificationToken = mocks.token; } }));
vi.mock('@/services/mail/mailer', () => ({ sendEmail: mocks.send }));
vi.mock('@/utils/password', () => ({ hashPassword: async () => 'derived-hash', PasswordProcessingBusy: class extends Error {} }));
vi.mock('@/utils/template', () => ({ renderTemplate: (_: string, values: { emailVerificationURL: string }) => values.emailVerificationURL }));
import { ResendEmailVerificationService } from '@/services/auth/resend-email-verification-service';
beforeEach(() => vi.resetAllMocks());
it('returns the same generic response for absent, already verified, and cooling-down accounts', async () => {
  mocks.find.mockResolvedValueOnce(null).mockResolvedValue({ id: 'user' }); mocks.claim.mockResolvedValue(null);
  const missing = await ResendEmailVerificationService('missing@example.test');
  expect(await ResendEmailVerificationService('verified@example.test')).toEqual(missing);
  expect(await ResendEmailVerificationService('cooldown@example.test')).toEqual(missing);
  expect(mocks.send).not.toHaveBeenCalled(); expect(missing.code).toBe(202);
});
it('resends the claimed valid link, and hides SMTP failure details', async () => {
  mocks.find.mockResolvedValue({ id: 'user' });
  mocks.claim.mockResolvedValue({ user: { email: 'citizen@example.test', name: 'Citizen' }, token: { token: 'still-valid', expiresAt: new Date('2026-10-05') } });
  mocks.send.mockRejectedValue(new Error('SMTP secret or recipient'));
  expect((await ResendEmailVerificationService(' Citizen@Example.test ')).code).toBe(202);
  expect(mocks.find).toHaveBeenCalledWith('citizen@example.test');
  expect(mocks.send.mock.calls[0][0].html).toContain('token=still-valid');
  expect(mocks.send.mock.calls[0][0].accountAction).toMatchObject({ purpose: 'VERIFY_EMAIL', url: mocks.send.mock.calls[0][0].html, expiresAt: new Date('2026-10-05').toISOString() });
});
it('reports retained account truthfully when initial mail or token creation fails', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const { SignupUserService } = await import('@/services/auth/signup-user-service');
  mocks.find.mockResolvedValue(null); mocks.create.mockResolvedValue({ id: 'user', email: 'citizen@example.test' });
  mocks.token.mockResolvedValue({}); mocks.send.mockRejectedValue(new Error('mail unavailable'));
  expect(await SignupUserService('Citizen', 'CITIZEN@example.test', 'StrongPassword123')).toMatchObject({ code: 200, message: expect.stringContaining('delivery failed') });
  expect(mocks.create.mock.calls[0][0]).toMatchObject({ email: 'citizen@example.test', password: 'derived-hash' });
  expect(mocks.send.mock.calls[0][0].accountAction).toMatchObject({ purpose: 'VERIFY_EMAIL', url: mocks.send.mock.calls[0][0].html });
  expect(mocks.send.mock.calls[0][0].accountAction.expiresAt).toBe(mocks.token.mock.calls[0][0].expiresAt.toISOString());
  mocks.token.mockRejectedValue(new Error('token persistence unavailable'));
  expect(await SignupUserService('Citizen', 'citizen@example.test', 'StrongPassword123')).toMatchObject({ code: 200, message: expect.stringContaining('delivery is unavailable') });
  vi.unstubAllEnvs();
});
