import crypto from 'node:crypto';
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
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('sends production signup verification through the actual Brevo mailer without auto-verifying', async () => {
  mocks.find.mockResolvedValue(null); mocks.create.mockResolvedValue(citizen); mocks.token.mockResolvedValue({});
  const fetcher = vi.fn().mockResolvedValue(new Response('{"messageId":"<signup@relay.example.test>"}', { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  const { SignupUserService } = await import('@/services/auth/signup-user-service');
  expect(await SignupUserService(citizen.name, citizen.email, 'synthetic-password')).toMatchObject({ code: 200, message: expect.stringContaining('Please verify') });
  expect(mocks.create.mock.calls[0][0].emailVerified).toBeUndefined();
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.subject).toBe('Verify your email address');
  expect(body.to).toEqual([{ email: citizen.email }]);
  expect(body.htmlContent).toContain(`https://account.example.test/api/auth/v1/verify-email?token=${mocks.token.mock.calls[0][0].token}`);
  expect(body.htmlContent).toContain('&lt;script&gt;synthetic&lt;/script&gt;');
  expect(body.htmlContent).not.toContain(citizen.name); expect(fetcher).toHaveBeenCalledOnce();
  expect(mocks.smtp).not.toHaveBeenCalled();
});

it.each(['gateway', 'environment'])('labels every controlled staging account flow via %s without changing links', async (source) => {
  vi.stubEnv('API_GATEWAY_AUDIENCE', source === 'gateway' ? 'emergency-response-staging-v1' : '');
  vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', source === 'environment' ? 'staging' : '');
  const claim = { user: citizen, token: { token: '12345678-1234-4123-8123-123456789abc', expiresAt: new Date(Date.now() + 60_000) } };
  mocks.find.mockResolvedValueOnce(null).mockResolvedValue(citizen);
  mocks.create.mockResolvedValue(citizen); mocks.token.mockResolvedValue({});
  mocks.claim.mockResolvedValue(claim); mocks.resetToken.mockResolvedValue({});
  const fetcher = vi.fn().mockImplementation(async () => new Response('{"messageId":"<staging@relay.example.test>"}', { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  const { SignupUserService } = await import('@/services/auth/signup-user-service');
  const { ResendEmailVerificationService } = await import('@/services/auth/resend-email-verification-service');
  const { RequestPasswordResetService } = await import('@/services/auth/password-reset-service');
  await SignupUserService(citizen.name, citizen.email, 'synthetic-password');
  await ResendEmailVerificationService(citizen.email);
  await RequestPasswordResetService(citizen.email);
  const messages = fetcher.mock.calls.map(call => JSON.parse(call[1].body));
  expect(messages.map(message => message.subject)).toEqual([
    '[STAGING TEST] Verify your email address', '[STAGING TEST] Verify your email address',
    '[STAGING TEST] Reset your Emergency Response password',
  ]);
  expect(messages.every(message => message.to.length === 1 && message.to[0].email === citizen.email)).toBe(true);
  expect(messages[0].htmlContent).toContain(`token=${mocks.token.mock.calls[0][0].token}`);
  expect(messages[1].htmlContent).toContain(`token=${claim.token.token}`);
  expect(messages[2].htmlContent).toContain('https://account.example.test/login?resetToken=');
  expect(mocks.smtp).not.toHaveBeenCalled();
});

it('resends only the existing claimed link and preserves generic acceptance on provider failure', async () => {
  const claim = { user: citizen, token: { token: '12345678-1234-4123-8123-123456789abc', expiresAt: new Date(Date.now() + 60_000) } };
  mocks.find.mockResolvedValue(citizen); mocks.claim.mockResolvedValue(claim);
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"messageId":"<resend@relay.example.test>"}', { status: 201 }))
    .mockResolvedValueOnce(new Response('private-provider-content', { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  const { ResendEmailVerificationService } = await import('@/services/auth/resend-email-verification-service');
  const accepted = await ResendEmailVerificationService(citizen.email);
  expect(JSON.parse(fetcher.mock.calls[0][1].body).htmlContent).toContain(`token=${claim.token.token}`);
  expect(await ResendEmailVerificationService(citizen.email)).toEqual(accepted);
  mocks.claim.mockResolvedValue(null);
  expect(await ResendEmailVerificationService(citizen.email)).toEqual(accepted);
  mocks.find.mockResolvedValue(null);
  expect(await ResendEmailVerificationService('unknown@example.test')).toEqual(accepted);
  expect(fetcher).toHaveBeenCalledTimes(2); expect(mocks.token).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-provider-content');
});

it('sends reset links through Brevo, stores only the digest and preserves privacy on failure', async () => {
  mocks.find.mockResolvedValue(citizen); mocks.resetToken.mockResolvedValue({});
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"messageId":"<reset@relay.example.test>"}', { status: 201 }))
    .mockResolvedValueOnce(new Response('private-provider-content', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  const { RequestPasswordResetService } = await import('@/services/auth/password-reset-service');
  const accepted = await RequestPasswordResetService('  CITIZEN@example.test  ');
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  const href = body.htmlContent.match(/href="([^"]+)"/)[1];
  expect(href).toMatch(/^https:\/\/account\.example\.test\/login\?resetToken=[a-f0-9]{64}$/);
  const token = new URL(href).searchParams.get('resetToken')!;
  expect(mocks.resetToken.mock.calls[0][0].data.token).toBe(crypto.createHash('sha256').update(token).digest('hex'));
  expect(await RequestPasswordResetService(citizen.email)).toEqual(accepted);
  mocks.find.mockResolvedValue(null);
  expect(await RequestPasswordResetService('unknown@example.test')).toEqual(accepted);
  expect(fetcher).toHaveBeenCalledTimes(2); expect(mocks.smtp).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-provider-content');
});
