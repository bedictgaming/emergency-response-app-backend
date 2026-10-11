import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
const canonical = 'https://cordova-emergency-response.site';
const legacy = 'https://cordova-emergency-response.vercel.app';
const secret = 'synthetic-dual-domain-gateway-not-a-credential';
const audience = 'emergency-response-production-v1';
const oauth = vi.hoisted(() => vi.fn());
vi.mock('@/config/env', async original => ({ ENV: { ...(await original<typeof import('@/config/env')>()).ENV,
  FRONTEND_URL: 'https://cordova-emergency-response.site', BACKEND_URL: 'https://cordova-emergency-response.site',
  ADDITIONAL_FRONTEND_ORIGINS: ['https://cordova-emergency-response.vercel.app'], API_GATEWAY_REQUIRED: true, API_GATEWAY_AUDIENCE: 'emergency-response-production-v1' } }));
vi.mock('@/lib/passport', () => ({ default: { authenticate: (...args: unknown[]) => oauth(...args) } }));
vi.mock('@/services/auth', () => ({ GoogleOAuthService: async () => ({ code: 403, errorCode: 'oauth_link_password_required' }) }));
import { createApiGatewayGuard } from '@/middlewares/api-gateway';
import { originGuard } from '@/middlewares/origin-guard';
import { trustedOrigins } from '@/lib/public-origin';
import auth from '@/routes/auth.routes';
const app = express();
app.use(createApiGatewayGuard({ required: true, secret, audience }));
app.use(originGuard, cors({ origin: (origin, done) => done(null, !!origin && trustedOrigins.has(origin)), credentials: true }));
app.use(cookieParser(), express.json());
app.use('/api/auth', auth);
let serial = 0;
function proof(method: string, path: string, appOrigin?: string, origin = '', cookie = '') {
  const time = String(Date.now()), nonce = (++serial).toString(16).padStart(32, '0');
  const values = [appOrigin ? 'er-api-gateway-v2' : 'er-api-gateway-v1', audience, time, nonce, method, path, '192.0.2.50', cookie, '', origin, '', ''];
  if (appOrigin) values.push(appOrigin);
  return { 'x-er-gateway-ip': '192.0.2.50', 'x-er-gateway-time': time, 'x-er-gateway-nonce': nonce,
    'x-er-gateway-signature': createHmac('sha256', secret).update(JSON.stringify(values)).digest('hex'),
    ...(appOrigin ? { 'x-er-gateway-origin': appOrigin } : {}), ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) };
}
it('starts and completes state-validated Google callbacks on the same approved alias; forwarded hosts cannot choose it', async () => {
  oauth.mockImplementation((_name, options) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (options.scope) return res.status(204).end();
    req.user = {};
    next();
  });
  for (const appOrigin of [canonical, legacy, undefined]) {
    const expected = appOrigin || legacy;
    const path = '/api/auth/v1/google';
    const start = await request(app).get(path).set(proof('GET', path, appOrigin)).set('x-forwarded-host', 'evil.invalid').expect(204);
    expect(oauth).toHaveBeenLastCalledWith('google', expect.objectContaining({ callbackURL: expected + '/api/auth/v1/google/callback' }));
    const cookie = (start.headers['set-cookie'] as unknown as string[]).find(value => value.startsWith('google_oauth_state='))!.split(';')[0];
    const state = cookie.split('=')[1];
    const callback = `/api/auth/v1/google/callback?state=${state}`;
    const finish = await request(app).get(callback).set(proof('GET', callback, appOrigin, '', cookie)).expect(302);
    expect(finish.headers.location).toBe(expected + '/login?oauth=oauth_link_password_required');
    expect(oauth).toHaveBeenLastCalledWith('google', expect.objectContaining({ session: false, callbackURL: expected + '/api/auth/v1/google/callback' }));
  }
});
it('permits both exact mutation/CORS origins but rejects lookalikes and hostile origins before the action', async () => {
  const path = '/api/auth/v1/logout';
  for (const origin of [canonical, legacy]) {
    const response = await request(app).post(path).set(proof('POST', path, origin, origin)).send({}).expect(200);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers.vary).toContain('Origin');
    expect((response.headers['set-cookie'] as unknown as string[]).every(cookie => !cookie.includes('Domain='))).toBe(true);
  }
  for (const origin of ['https://evil.invalid', canonical + '.evil.invalid'])
    await request(app).post(path).set(proof('POST', path, canonical, origin)).send({}).expect(403);
});
