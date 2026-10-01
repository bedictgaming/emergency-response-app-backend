import { it, expect, vi } from 'vitest';
import request from 'supertest';
import { createHmac, randomBytes } from 'node:crypto';
vi.mock('@/config/env', async (original) => {
  const { ENV } = await original<typeof import('@/config/env')>();
  return { ENV: { ...ENV, API_GATEWAY_REQUIRED: true,
    API_GATEWAY_SECRET: 'app-gateway-unit-secret-not-a-real-credential', API_GATEWAY_AUDIENCE: 'emergency-response-staging-v1' } };
});
import app from '@/app';
function proof(path: string, method = 'GET', cookie = '', origin = '') {
  const time = String(Date.now()); const nonce = randomBytes(16).toString('hex'); const ip = '192.0.2.99';
  const payload = JSON.stringify(['er-api-gateway-v1', 'emergency-response-staging-v1', time, nonce,
    method, path, ip, cookie, '', origin, '', '']);
  return { 'x-er-gateway-ip': ip, 'x-er-gateway-time': time, 'x-er-gateway-nonce': nonce,
    'x-er-gateway-signature': createHmac('sha256', 'app-gateway-unit-secret-not-a-real-credential').update(payload).digest('hex'),
    ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) };
}
it('applies the boundary before all API routes but leaves health checks available', async () => {
  for (const path of ['/api/auth/v1/me', '/api/events/v1/stream', '/api/incidents/v1/?limit=5', '/api/upload/v1/signature', '/api/alerts/v1/']) {
    const res = await request(app).get(path);
    expect(res.status).toBe(403); expect(res.headers['cache-control']).toBe('no-store');
  }
  expect((await request(app).get('/healthz')).status).toBe(200);
  expect(app.get('trust proxy')).toBe(false);
});
it('gateway proof never replaces user authentication, including forged cookies', async () => {
  for (const path of ['/api/auth/v1/me', '/api/events/v1/stream', '/api/incidents/v1/?limit=5']) {
    const res = await request(app).get(path).set(proof(path, 'GET', 'accessToken=invalid'));
    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.headers).some(name => name.startsWith('x-er-gateway-'))).toBe(false);
  }
});
it('preserves JSON validation and cross-origin mutation protection after the boundary', async () => {
  const path = '/api/auth/v1/login';
  const malformed = await request(app).post(path).set(proof(path, 'POST')).set('Content-Type', 'application/json').send('{');
  expect(malformed.status).toBe(400);
  const rejected = await request(app).post(path).set(proof(path, 'POST', '', 'https://evil.invalid')).send({});
  expect(rejected.status).toBe(403); expect(rejected.body.message).toBe('Request origin is not allowed');
});
