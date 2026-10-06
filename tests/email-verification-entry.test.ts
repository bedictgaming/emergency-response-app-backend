import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verificationEmailUrl } from '@/services/auth/verification-email-url';
import { AuthController } from '@/controllers/auth.controller';
import { VerifyEmailService } from '@/services/auth';

vi.mock('@/services/auth', () => ({ VerifyEmailService: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

const token = '11111111-1111-4111-8111-111111111111';
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => vi.clearAllMocks());

describe('verification email entry', () => {
  it('uses an explicit UI action for Brevo and preserves legacy transports', () => {
    vi.stubEnv('MAIL_PROVIDER', 'brevo');
    vi.stubEnv('FRONTEND_URL', 'https://staging.example.test/');
    vi.stubEnv('BACKEND_URL', 'https://api.example.test');
    expect(verificationEmailUrl(token)).toBe(`https://staging.example.test/login?verificationToken=${token}`);
    vi.stubEnv('MAIL_PROVIDER', 'smtp');
    expect(verificationEmailUrl(token)).toBe(`https://api.example.test/api/auth/v1/verify-email?token=${token}`);
  });

  it.each(['', 'http://example.test', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test/?token=other', 'https://example.test/#fragment'])('fails closed for an unsafe frontend setting', origin => {
    vi.stubEnv('MAIL_PROVIDER', 'brevo');
    vi.stubEnv('FRONTEND_URL', origin);
    expect(() => verificationEmailUrl(token)).toThrow();
  });

  it.each([200, 404, 410, 500])('returns the actual service status for an explicit JSON action (%s)', async code => {
    const result = { code, status: code === 200 ? 'success' : 'error', message: 'Verification result' };
    vi.mocked(VerifyEmailService).mockResolvedValueOnce(result);
    const res = { status: vi.fn(), json: vi.fn(), redirect: vi.fn(), cookie: vi.fn() };
    res.status.mockReturnValue(res);
    await new AuthController().verifyEmail({ query: { token }, get: () => 'application/json' } as never, res as never);
    expect(VerifyEmailService).toHaveBeenCalledExactlyOnceWith(token);
    expect(res.status).toHaveBeenCalledWith(code);
    expect(res.json).toHaveBeenCalledWith(result);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it.each([200, 404, 410])('preserves old emailed browser redirects (%s)', async code => {
    vi.stubEnv('FRONTEND_URL', 'https://staging.example.test');
    vi.mocked(VerifyEmailService).mockResolvedValueOnce({ code, status: code === 200 ? 'success' : 'error', message: 'Verification result' });
    const res = { redirect: vi.fn(), cookie: vi.fn() };
    await new AuthController().verifyEmail({ query: { token }, get: () => 'text/html' } as never, res as never);
    expect(res.redirect).toHaveBeenCalledWith(`https://staging.example.test/?${code === 200 ? 'verified=true' : 'error=verification_failed'}`);
    expect(res.cookie).not.toHaveBeenCalled();
  });
});
