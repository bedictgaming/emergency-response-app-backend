import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ begin: vi.fn(), claim: vi.fn(), complete: vi.fn(), unlink: vi.fn(), status: vi.fn(), exchange: vi.fn(), passport: vi.fn() }));
vi.mock('@/lib/passport', () => ({ default: { initialize: () => (_q: unknown, _s: unknown, next: () => void) => next(), authenticate: mocks.passport } }));
vi.mock('@/middlewares/auth-middleware', () => ({ AuthMiddleware: class { execute = (req: any, res: any, next: () => void) => {
  if (!req.get('x-synthetic-role')) return res.status(401).json({ code: 401 });
  req.user = { sub: 'synthetic-user', sessionId: 'synthetic-session', role: req.get('x-synthetic-role') }; next();
} } }));
vi.mock('@/services/auth/google-link-service', async importOriginal => ({ ...await importOriginal<typeof import('@/services/auth/google-link-service')>(),
  beginGoogleLink: mocks.begin, claimGoogleLink: mocks.claim, completeGoogleLink: mocks.complete, unlinkGoogle: mocks.unlink, googleLinkStatus: mocks.status }));
vi.mock('@/services/auth/google-link-provider', async importOriginal => ({ ...await importOriginal<typeof import('@/services/auth/google-link-provider')>(), exchangeGoogleLinkCode: mocks.exchange }));
import request from 'supertest';
import app from '@/app';
import { ENV } from '@/config/env';
import { GoogleLinkError } from '@/services/auth/google-link-service';
const state = `link.${'a'.repeat(43)}`;
const verifier = 'b'.repeat(43);
const callback = `/api/auth/v1/google/callback?state=${state}&code=synthetic-code`;
const cookies = `google_link_state=${state}; google_link_verifier=${verifier}`;
beforeEach(() => {
  vi.clearAllMocks(); mocks.begin.mockResolvedValue({ state, verifier, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?synthetic' });
  mocks.claim.mockResolvedValue({ id: 'synthetic-intent', consumedAt: new Date() }); mocks.complete.mockResolvedValue(undefined);
  mocks.unlink.mockResolvedValue(undefined); mocks.status.mockResolvedValue({ available: true, linked: false, hasPassword: true });
  mocks.exchange.mockResolvedValue({ sub: 'synthetic-provider-id', email: 'synthetic@gmail.com' });
});
describe('Google linking HTTP boundary (synthetic sessions/provider)', () => {
  it.each(['GET', 'POST'])('requires authentication for %s link', async method => {
    const action = request(app)[method === 'GET' ? 'get' : 'post']('/api/auth/v1/google/link');
    await action.send(method === 'POST' ? { password: 'synthetic' } : undefined).expect(401);
    expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.status).not.toHaveBeenCalled();
  });
  it('rejects foreign-origin password submissions before password/service access', async () => {
    await request(app).post('/api/auth/v1/google/link').set('x-synthetic-role', 'USER').set('Origin', 'https://untrusted.example').send({ password: 'synthetic' }).expect(403);
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it.each([{ password: '' }, { password: 'x', userId: 'other' }, { password: 'x', role: 'ADMIN' }, { password: 'x'.repeat(4097) }])('accepts only a bounded password body', async body => {
    await request(app).post('/api/auth/v1/google/link').set('x-synthetic-role', 'USER').send(body).expect(400);
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it('sets scoped short-lived HttpOnly cookies and returns no verifier', async () => {
    const result = await request(app).post('/api/auth/v1/google/link').set('x-synthetic-role', 'USER').send({ password: 'synthetic' }).expect(200);
    const issued = (result.headers['set-cookie'] as unknown as string[]).filter(value => value.includes('Max-Age=300'));
    expect(issued).toHaveLength(2);
    for (const cookie of issued) { expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Lax'); expect(cookie).toContain('Path=/api/auth/v1/google'); expect(cookie).not.toContain('Domain='); }
    expect(JSON.stringify(result.body)).not.toContain(verifier);
    expect(result.headers['cache-control']).toContain('no-store');
  });
  it('never falls through to ordinary sign-in on an unauthenticated linking callback', async () => {
    await request(app).get(callback).set('Cookie', cookies).expect(401);
    expect(mocks.passport).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it('rejects mismatched browser state without contacting Google', async () => {
    const result = await request(app).get(callback).set('x-synthetic-role', 'USER').set('Cookie', `google_link_state=link.${'c'.repeat(43)}; google_link_verifier=${verifier}`).expect(302);
    expect(result.headers.location).toBe(`${ENV.FRONTEND_URL}/dashboard?googleLink=expired`);
    expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.passport).not.toHaveBeenCalled();
  });
  it('consumes cancellation without exchange, clears cookies and returns only an enum', async () => {
    const result = await request(app).get(`/api/auth/v1/google/callback?state=${state}&error=private-provider-error`).set('x-synthetic-role', 'USER').set('Cookie', cookies).expect(302);
    expect(mocks.claim).toHaveBeenCalledOnce(); expect(mocks.exchange).not.toHaveBeenCalled();
    expect(result.headers.location).toBe(`${ENV.FRONTEND_URL}/dashboard?googleLink=cancelled`);
    expect(result.headers['set-cookie']).toHaveLength(2); expect(result.headers['referrer-policy']).toBe('no-referrer');
  });
  it('claims before exchange and completion, returns no new auth cookies', async () => {
    const result = await request(app).get(callback).set('x-synthetic-role', 'USER').set('Cookie', cookies).expect(302);
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(mocks.exchange.mock.invocationCallOrder[0]);
    expect(mocks.exchange.mock.invocationCallOrder[0]).toBeLessThan(mocks.complete.mock.invocationCallOrder[0]);
    expect(result.headers.location).toBe(`${ENV.FRONTEND_URL}/dashboard?googleLink=linked`);
    expect((result.headers['set-cookie'] as unknown as string[]).some(value => /^accessToken=|^refreshToken=/.test(value))).toBe(false);
    expect(mocks.passport).not.toHaveBeenCalled();
  });
  it('sanitizes provider failure without fallback', async () => {
    mocks.exchange.mockRejectedValueOnce(new Error('private-provider-secret'));
    const result = await request(app).get(callback).set('x-synthetic-role', 'USER').set('Cookie', cookies).expect(302);
    expect(result.headers.location).toBe(`${ENV.FRONTEND_URL}/dashboard?googleLink=failed`);
    expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.passport).not.toHaveBeenCalled();
  });
  it('keeps service role denial intact', async () => {
    mocks.begin.mockRejectedValueOnce(new GoogleLinkError(403, 'not_allowed', 'Only citizens may link Google.'));
    await request(app).post('/api/auth/v1/google/link').set('x-synthetic-role', 'ADMIN').send({ password: 'synthetic' }).expect(403);
  });
  it('clears old authentication cookies after successful password-confirmed unlink', async () => {
    const result = await request(app).post('/api/auth/v1/google/unlink').set('x-synthetic-role', 'USER').send({ password: 'synthetic' }).expect(200);
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ sub: 'synthetic-user' }), 'synthetic');
    expect((result.headers['set-cookie'] as unknown as string[]).filter(value => /^(accessToken|refreshToken|sessionRenewAt)=/.test(value))).toHaveLength(3);
  });
});

