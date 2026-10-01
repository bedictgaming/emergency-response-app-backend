import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { createHmac } from 'node:crypto';
import { createApiGatewayGuard, clientIpRateLimitKey } from '@/middlewares/api-gateway';

const secret = 'gateway-unit-test-secret-not-a-credential';
const audience = 'emergency-response-staging-v1';
const initial = 1790800000000;
let serial = 0;
function signed({ method = 'GET', path = '/api/check', ip = '192.0.2.10', time = initial,
  nonce = (++serial).toString(16).padStart(32, '0'), cookie = '', authorization = '', origin = '',
  referer = '', site = '', key = secret, aud = audience } = {}) {
  const payload = JSON.stringify(['er-api-gateway-v1', aud, String(time), nonce, method,
    path, ip, cookie, authorization, origin, referer, site]);
  return { 'x-er-gateway-ip': ip, 'x-er-gateway-time': String(time), 'x-er-gateway-nonce': nonce,
    'x-er-gateway-signature': createHmac('sha256', key).update(payload).digest('hex'),
    ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}),
    ...(origin ? { origin } : {}), ...(referer ? { referer } : {}), ...(site ? { 'sec-fetch-site': site } : {}) };
}
function harness({ required = true, limit = 100, maxNonces = 20000 } = {}) {
  let clock = initial;
  const app = express();
  app.set('trust proxy', false);
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use((req, res, next) => req.path.startsWith('/api/')
    ? createGuard(req, res, next) : next());
  const createGuard = createApiGatewayGuard({ required, secret, audience }, { now: () => clock, maxNonces });
  app.use('/api', rateLimit({ limit, windowMs: 60000, keyGenerator: clientIpRateLimitKey, legacyHeaders: false }));
  app.all('/api/check', (req, res) => res.json({ ip: req.ip, key: clientIpRateLimitKey(req),
    gatewayHeaderRetained: Object.keys(req.headers).some(name => name.startsWith('x-er-gateway-')) }));
  app.get('/healthz', (_req, res) => res.sendStatus(200));
  return { app, clock: (value: number) => { clock = value; } };
}

describe('authenticated API gateway boundary', () => {
  it('fails configuration closed without a dedicated secret and valid audience', () => {
    expect(() => createApiGatewayGuard({ required: true, secret: '', audience })).toThrow();
    expect(() => createApiGatewayGuard({ required: true, secret, audience: '' })).toThrow();
  });
  it('rejects direct and spoofed provider headers without exposing diagnostics', async () => {
    const { app } = harness();
    const res = await request(app).get('/api/check').set({ 'x-forwarded-for': '192.0.2.99',
      'x-real-ip': '192.0.2.99', 'x-vercel-forwarded-for': '192.0.2.99' });
    expect(res.status).toBe(403); expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ code: 403, status: 'error', message: 'Verified API gateway required' });
    expect((await request(app).get('/healthz')).status).toBe(200);
  });
  it('accepts authentic metadata, ignores other IP headers and strips proof headers', async () => {
    const { app } = harness();
    const res = await request(app).get('/api/check').set(signed()).set('x-vercel-forwarded-for', '198.51.100.99');
    expect(res.status).toBe(200); expect(res.body.ip).toBe('192.0.2.10');
    expect(res.body.gatewayHeaderRetained).toBe(false);
  });
  it('binds signature to method, exact path/query and credentials/origin', async () => {
    const { app } = harness();
    for (const patch of [ { 'x-er-gateway-ip': '192.0.2.11' }, { cookie: 'different-session' },
      { authorization: 'Bearer forged' }, { origin: 'https://evil.invalid' }, { referer: 'https://evil.invalid' },
      { 'sec-fetch-site': 'cross-site' } ]) {
      expect((await request(app).get('/api/check').set({ ...signed(), ...patch })).status).toBe(403);
    }
    expect((await request(app).post('/api/check').set(signed())).status).toBe(403);
    expect((await request(app).get('/api/check?limit=1').set(signed())).status).toBe(403);
    expect((await request(app).get('/api/check?limit=1&x=a%2Fb').set(signed({ path: '/api/check?limit=1&x=a%2Fb' }))).status).toBe(200);
    expect((await request(app).get('/api/check/').set(signed({ path: '/api/check/' }))).status).toBe(200);
  });
  it('rejects wrong environment secrets/audiences, malformed IPs and signatures', async () => {
    const { app } = harness();
    for (const headers of [signed({ key: 'another-secret' }), signed({ aud: 'production' }),
      signed({ ip: '192.0.2.1, 192.0.2.2' }), signed({ ip: 'unknown' }),
      { ...signed(), 'x-er-gateway-signature': 'z'.repeat(64) },
      { ...signed(), 'x-er-gateway-nonce': 'invalid' }]) {
      expect((await request(app).get('/api/check').set(headers)).status).toBe(403);
    }
  });
  it('rejects old, future and reused proofs', async () => {
    const { app } = harness();
    expect((await request(app).get('/api/check').set(signed({ time: initial - 60001 }))).status).toBe(403);
    expect((await request(app).get('/api/check').set(signed({ time: initial + 5001 }))).status).toBe(403);
    const proof = signed();
    expect((await request(app).get('/api/check').set(proof)).status).toBe(200);
    expect((await request(app).get('/api/check').set(proof)).status).toBe(403);
  });
  it('bounds replay memory without evicting live proofs, and recovers after expiry', async () => {
    const h = harness({ maxNonces: 1 });
    expect((await request(h.app).get('/api/check').set(signed())).status).toBe(200);
    const full = await request(h.app).get('/api/check').set(signed());
    expect(full.status).toBe(503); expect(full.headers['retry-after']).toBe('2');
    h.clock(initial + 60001);
    expect((await request(h.app).get('/api/check').set(signed({ time: initial + 60001 }))).status).toBe(200);
  });
  it('separates independent client quotas; fake provider headers cannot reset them', async () => {
    const { app } = harness({ limit: 2 });
    for (let i = 0; i < 2; i++) expect((await request(app).get('/api/check').set(signed())).status).toBe(200);
    expect((await request(app).get('/api/check').set(signed()).set('x-vercel-forwarded-for', '192.0.2.11')).status).toBe(429);
    expect((await request(app).get('/api/check').set(signed({ ip: '192.0.2.11' }))).status).toBe(200);
  });
  it('retains IPv6 subnet grouping and ignores all gateway metadata when disabled', async () => {
    const { app } = harness({ limit: 1 });
    expect((await request(app).get('/api/check').set(signed({ ip: '2001:db8:abcd:1000::1' }))).status).toBe(200);
    expect((await request(app).get('/api/check').set(signed({ ip: '2001:db8:abcd:10ff::2' }))).status).toBe(429);
    const disabled = harness({ required: false });
    const res = await request(disabled.app).get('/api/check').set(signed());
    expect(res.status).toBe(200); expect(res.body.ip).not.toBe('192.0.2.10');
    expect(res.body.gatewayHeaderRetained).toBe(false);
  });
});
