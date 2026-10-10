import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn(), claim: vi.fn(), unlink: vi.fn(), methods: vi.fn(), passport: vi.fn(), google: vi.fn(), verifyAccess: vi.fn() }));
const actor = { sub: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', role: 'USER', type: 'access' };
vi.mock('@/middlewares/auth-middleware', () => ({ AuthMiddleware: class {
  execute(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (req.headers.authorization !== 'Bearer synthetic') return res.status(401).json({ code: 401 });
    req.user = { sub: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', role: 'USER' }; next();
  }
} }));
vi.mock('@/services/auth/google-link-service', () => ({ BeginGoogleLinkService: mocks.begin, CompleteGoogleLinkService: mocks.finish, ClaimGoogleLinkService: mocks.claim, UnlinkGoogleService: mocks.unlink, GetLoginMethodsService: mocks.methods }));
vi.mock('@/services/auth', () => ({ GoogleOAuthService: mocks.google }));
vi.mock('@/lib/jwt', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/jwt')>(), verifyAccessToken: mocks.verifyAccess }));
vi.mock('@/lib/passport', () => ({ default: { authenticate: mocks.passport } }));
import router from '@/routes/auth.routes';
const app = express(); app.use(express.json(), cookieParser(), router);
const state = 'link.' + 'a'.repeat(43), verifier = 'b'.repeat(43);
const cookies = `google_oauth_state=${state}; google_link_verifier=${verifier}; accessToken=synthetic`;
beforeEach(() => {
  vi.resetAllMocks(); mocks.verifyAccess.mockReturnValue(actor); mocks.claim.mockResolvedValue({ userId: actor.sub, sessionId: actor.sessionId });
  mocks.begin.mockResolvedValue({ code: 200, status: 'success', data: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' }, state, verifier });
  mocks.finish.mockResolvedValue({ code: 200, status: 'success' }); mocks.unlink.mockResolvedValue({ code: 200, status: 'success' });
  mocks.passport.mockImplementation((_name, _options, callback) => (_req: unknown, _res: unknown, _next: unknown) => callback(null, { provider: 'google', id: 'synthetic-sub' }));
});
it('restored actions still require authentication', async () => {
  for (const path of ['/v1/google/link', '/v1/google/unlink']) await request(app).post(path).send({ accountId: actor.sub, password: 'password' }).expect(401);
  await request(app).get('/v1/login-methods').expect(401);
  expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled(); expect(mocks.methods).not.toHaveBeenCalled();
});
it('strictly validates confirmation and never accepts privilege/provider inputs', async () => {
  for (const body of [{ accountId: actor.sub }, { accountId: actor.sub, password: '' }, { accountId: actor.sub, password: 'password', role: 'ADMIN' }, { accountId: 'malformed', password: 'password' }])
    await request(app).post('/v1/google/link').set('Authorization', 'Bearer synthetic').send(body).expect(400);
  expect(mocks.begin).not.toHaveBeenCalled();
});
it('refuses an account-switch before any service mutation', async () => {
  for (const path of ['/v1/google/link', '/v1/google/unlink']) await request(app).post(path).set('Authorization', 'Bearer synthetic')
    .send({ accountId: '00000000-0000-4000-8000-000000000099', password: 'password' }).expect(409);
  expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled();
});
it('keeps the PKCE verifier HttpOnly and out of JSON', async () => {
  const response = await request(app).post('/v1/google/link').set('Authorization', 'Bearer synthetic').send({ accountId: actor.sub, password: 'password' }).expect(200);
  expect(response.body).toEqual({ code: 200, status: 'success', data: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' } });
  const setCookies = response.headers['set-cookie'] as unknown as string[];
  expect(setCookies).toHaveLength(2);
  expect(setCookies.every(cookie => cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax') && cookie.includes('Max-Age=300'))).toBe(true);
  expect(JSON.stringify(response.body)).not.toContain(verifier);
});
it('links only after a browser-bound one-time claim, using actual code verifier', async () => {
  const response = await request(app).get(`/v1/google/callback?state=${state}&code=synthetic-code`).set('Cookie', cookies).expect(302);
  expect(response.headers.location).toMatch(/\/settings\?googleLink=linked$/);
  expect(mocks.claim).toHaveBeenCalledWith(actor, state, verifier);
  expect(mocks.passport).toHaveBeenCalledWith('google', { session: false, linkVerifier: verifier }, expect.any(Function));
  expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(mocks.passport.mock.invocationCallOrder[0]);
  expect(mocks.google).not.toHaveBeenCalled();
  expect((response.headers['set-cookie'] as unknown as string[]).every(cookie => !/^(accessToken|refreshToken)=/.test(cookie))).toBe(true);
});
it('expired/replayed intent cannot exchange a code or fall through to login', async () => {
  mocks.claim.mockResolvedValue(null);
  const response = await request(app).get(`/v1/google/callback?state=${state}&code=synthetic-code`).set('Cookie', cookies).expect(302);
  expect(response.headers.location).toMatch(/googleLink=expired$/); expect(mocks.passport).not.toHaveBeenCalled(); expect(mocks.google).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
});
it('cancellation consumes the intent without creating a method', async () => {
  const response = await request(app).get(`/v1/google/callback?state=${state}&error=access_denied`).set('Cookie', cookies).expect(302);
  expect(response.headers.location).toMatch(/googleLink=cancelled$/); expect(mocks.claim).toHaveBeenCalledOnce(); expect(mocks.passport).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
});
it('provider failures expose only an allowlisted result, not raw error details', async () => {
  mocks.passport.mockImplementation((_name, _options, callback) => () => callback(new Error('secret-provider-data')));
  const response = await request(app).get(`/v1/google/callback?state=${state}&code=synthetic-code`).set('Cookie', cookies).expect(302);
  expect(response.headers.location).toMatch(/googleLink=failed$/); expect(JSON.stringify(response.headers)).not.toContain('secret-provider-data'); expect(mocks.finish).not.toHaveBeenCalled();
});
it('malformed unicode state cannot crash timing-safe validation', async () => {
  await request(app).get('/v1/google/callback?state=' + encodeURIComponent('é'.repeat(48))).set('Cookie', cookies).expect(400);
  expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.passport).not.toHaveBeenCalled();
});
it('unlinking retains the existing cookie family without issuing a new session', async () => {
  const response = await request(app).post('/v1/google/unlink').set('Authorization', 'Bearer synthetic').send({ accountId: actor.sub, password: 'password' }).expect(200);
  expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ sub: actor.sub, sessionId: actor.sessionId }), 'password'); expect(response.headers['set-cookie']).toBeUndefined();
});
