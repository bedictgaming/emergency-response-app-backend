import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ find: vi.fn(), claim: vi.fn(), send: vi.fn(), create: vi.fn(), token: vi.fn() }));
vi.mock('@/repositories/user.repository', () => ({ UserRepository: class { findByEmail = mocks.find; create = mocks.create; } }));
vi.mock('@/repositories/token.repository', () => ({ TokenRepository: class { claimVerificationResend = mocks.claim; createEmailVerificationToken = mocks.token; } }));
vi.mock('@/services/mail/mailer', () => ({ sendEmail: mocks.send }));
vi.mock('@/utils/password', () => ({ hashPassword: async () => 'derived-hash', PasswordProcessingBusy: class extends Error {} }));
vi.mock('@/utils/template', () => ({ renderTemplate: (_: string, values: { emailVerificationURL: string }) => values.emailVerificationURL }));
import { ResendEmailVerificationService } from '@/services/auth/resend-email-verification-service';
beforeEach(() => vi.resetAllMocks());
it('retired verification resend is account-independent and never looks up, claims or sends', async () => {
  const retired = await ResendEmailVerificationService('missing@example.test');
  expect(retired).toMatchObject({ code: 410, status: 'error' });
  for (const email of ['verified@example.test', 'unverified@example.test', ' Citizen@Example.test ', '']) {
    expect(await ResendEmailVerificationService(email)).toEqual(retired);
  }
  for (const fn of Object.values(mocks)) expect(fn).not.toHaveBeenCalled();
});
it.each(['production', 'test'])('signup is immediately accessible with unconfirmed email in %s', async environment => {
  vi.stubEnv('NODE_ENV', environment);
  const { SignupUserService } = await import('@/services/auth/signup-user-service');
  mocks.find.mockResolvedValue(null);
  mocks.create.mockResolvedValue({ id: 'user', email: 'citizen@example.test', role: 'USER', emailVerified: null });
  mocks.token.mockRejectedValue(new Error('token persistence unavailable'));
  mocks.send.mockRejectedValue(new Error('provider unavailable'));
  expect(await SignupUserService('Citizen', ' CITIZEN@example.test ', 'StrongPassword123')).toMatchObject({
    code: 200, message: expect.stringContaining('now log in'), data: { user: { role: 'USER', emailVerified: null } },
  });
  expect(mocks.create).toHaveBeenCalledWith({ name: 'Citizen', email: 'citizen@example.test', password: 'derived-hash', emailVerified: null });
  expect(mocks.token).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
