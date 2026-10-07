import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ find: vi.fn(), create: vi.fn(), token: vi.fn(), claim: vi.fn(), resetToken: vi.fn(), smtp: vi.fn() }));
vi.mock('@/repositories/user.repository', () => ({ UserRepository: class { findByEmail = mocks.find; create = mocks.create; } }));
vi.mock('@/repositories/token.repository', () => ({ TokenRepository: class { createEmailVerificationToken = mocks.token; claimVerificationResend = mocks.claim; } }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: mocks.find }, token: { create: mocks.resetToken } } }));
vi.mock('@/config/env', () => ({ ENV: { FRONTEND_URL: 'https://account.example.test/' } }));
vi.mock('@/utils/password', () => ({ hashPassword: async () => 'synthetic-hash', PasswordProcessingBusy: class extends Error {} }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.smtp } }));

const citizen = { id: 'synthetic-user', email: 'citizen@example.test', name: '<script>synthetic</script>', status: 'ACTIVE' };
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('MAIL_PROVIDER', 'brevo');
  vi.stubEnv('MAIL_FROM', 'sender@example.test'); vi.stubEnv('BREVO_API_KEY', 'xkeysib-synthetic-test-key-only');
  vi.stubEnv('BACKEND_URL', 'https://account.example.test'); vi.stubEnv('APP_NAME', 'Account test');
  vi.stubEnv('FRONTEND_URL', 'https://account.example.test/');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('production citizen signup does not depend on Brevo or claim verified ownership', async () => {
  mocks.find.mockResolvedValue(null); mocks.create.mockResolvedValue({ ...citizen, emailVerified: null });
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const { SignupUserService } = await import('@/services/auth/signup-user-service');
  expect(await SignupUserService(citizen.name, citizen.email, 'synthetic-password')).toMatchObject({ code: 200, message: expect.stringContaining('now log in') });
  expect(mocks.create.mock.calls[0][0].emailVerified).toBeNull();
  expect(fetcher).not.toHaveBeenCalled(); expect(mocks.token).not.toHaveBeenCalled(); expect(mocks.smtp).not.toHaveBeenCalled();
});
it.each(['gateway', 'environment'])('labels restored staging reset via %s; signup and resend do not send', async source => {
  vi.stubEnv('API_GATEWAY_AUDIENCE', source === 'gateway' ? 'emergency-response-staging-v1' : '');
  vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', source === 'environment' ? 'staging' : '');
  mocks.find.mockResolvedValueOnce(null).mockResolvedValue(citizen); mocks.create.mockResolvedValue(citizen);
  const fetcher = vi.fn().mockResolvedValue(new Response('{"messageId":"<staging@relay.example.test>"}', { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  const { SignupUserService } = await import('@/services/auth/signup-user-service');
  const { ResendEmailVerificationService } = await import('@/services/auth/resend-email-verification-service');
  const { RequestPasswordResetService } = await import('@/services/auth/password-reset-service');
  await SignupUserService(citizen.name, citizen.email, 'synthetic-password');
  expect(await ResendEmailVerificationService(citizen.email)).toMatchObject({ code: 410 });
  expect(await RequestPasswordResetService(citizen.email)).toMatchObject({ code: 202 });
  expect(fetcher).toHaveBeenCalledOnce();
  const message = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(message.subject).toBe('[STAGING TEST] Reset your Emergency Response password');
  expect(message.to).toEqual([{ email: citizen.email }]);
  expect(message.htmlContent).toContain('https://account.example.test/login?resetToken=');
  expect(mocks.resetToken).toHaveBeenCalledOnce(); expect(mocks.token).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.smtp).not.toHaveBeenCalled();
});
