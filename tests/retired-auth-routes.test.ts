import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ signup: vi.fn(), login: vi.fn(), verify: vi.fn(), resetRequest: vi.fn(), resetConfirm: vi.fn(), database: vi.fn(), mail: vi.fn() }));
vi.mock('@/services/auth', () => ({
  SignupUserService: calls.signup, LoginCredentialsService: calls.login, VerifyEmailService: calls.verify,
  RefreshTokenService: vi.fn(), GetMeService: vi.fn(), GoogleOAuthService: vi.fn(),
  RequestPasswordResetService: calls.resetRequest, ResetPasswordService: calls.resetConfirm,
}));
vi.mock('@/lib/prisma', () => ({ prisma: { $queryRaw: calls.database } }));
vi.mock('@/services/mail/mailer', () => ({ sendEmail: calls.mail }));
vi.mock('@/lib/passport', () => ({ default: {
  initialize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authenticate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
} }));
vi.mock('@/routes', async () => ({ default: express.Router().use('/auth', (await import('@/routes/auth.routes')).default) }));
import app from '@/app';

beforeEach(() => vi.clearAllMocks());
it('restores validated POST recovery endpoints without session cookies', async () => {
  calls.resetRequest.mockResolvedValue({ code: 202, status: 'success', message: 'If eligible, delivery requested' });
  calls.resetConfirm.mockResolvedValue({ code: 200, status: 'success', message: 'Password reset successfully' });
  for (const [path, body, code] of [
    ['/request', { email: ' Synthetic@Example.test ' }, 202],
    ['/confirm', { token: 'a'.repeat(64), password: 'SyntheticOnly123' }, 200],
  ] as const) {
    const response = await request(app).post('/api/auth/v1/password-reset' + path).send(body).expect(code);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    await request(app).get('/api/auth/v1/password-reset' + path).expect(404);
  }
  // Middleware validates; the service owns normalization.
  expect(calls.resetRequest).toHaveBeenCalledWith(' Synthetic@Example.test ');
  expect(calls.resetConfirm).toHaveBeenCalledWith('a'.repeat(64), 'SyntheticOnly123');
});
it('rejects weak reset passwords before invoking the service', async () => {
  await request(app).post('/api/auth/v1/password-reset/confirm').send({ token: 'a'.repeat(64), password: 'short' }).expect(400);
  expect(calls.resetConfirm).not.toHaveBeenCalled();
});
it('public signup never passes verification or operational privilege inputs to the service', async () => {
  calls.signup.mockResolvedValue({ code: 200, status: 'success', data: { user: { role: 'USER', emailVerified: null } } });
  const response = await request(app).post('/api/auth/v1/signup').send({
    name: 'Synthetic', email: 'synthetic@example.test', password: 'SyntheticOnly123',
    role: 'ADMIN', department: 'MAIN', isMainAdmin: true, emailVerified: new Date().toISOString(),
  }).expect(200);
  expect(calls.signup).toHaveBeenCalledWith('Synthetic', 'synthetic@example.test', 'SyntheticOnly123');
  expect(response.body.data.user).toEqual({ role: 'USER', emailVerified: null });
});
it.each(['/resend-email-verification'])('retires the public API %s without side effects', async path => {
  for (const method of ['post', 'get'] as const) {
    const response = await request(app)[method](`/api/auth/v1${path}`).send({ email: 'synthetic@example.test', token: 'a'.repeat(64), password: 'SyntheticOnly123' });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 404, status: 'error' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
  }
  for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();
});
it('preserves signup, credential login rejection and explicit verification routes', async () => {
  calls.signup.mockResolvedValue({ code: 200, status: 'success', message: 'You can now log in.' });
  calls.login.mockResolvedValue({ code: 401, status: 'error', message: 'Invalid email or password' });
  calls.verify.mockResolvedValue({ code: 200, status: 'success', message: 'Email verified' });
  await request(app).post('/api/auth/v1/signup').send({ name: 'Synthetic', email: 'synthetic@example.test', password: 'SyntheticOnly123' }).expect(200);
  await request(app).post('/api/auth/v1/login').send({ email: 'synthetic@example.test', password: 'SyntheticOnly123' }).expect(401);
  const verified = await request(app).get('/api/auth/v1/verify-email?token=11111111-1111-4111-8111-111111111111').set('Accept', 'application/json').expect(200);
  expect(verified.headers['set-cookie']).toBeUndefined();
  expect(calls.signup).toHaveBeenCalledOnce(); expect(calls.login).toHaveBeenCalledOnce(); expect(calls.verify).toHaveBeenCalledOnce();
  expect(calls.database).not.toHaveBeenCalled(); expect(calls.mail).not.toHaveBeenCalled();
});
