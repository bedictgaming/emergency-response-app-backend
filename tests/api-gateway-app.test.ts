import { it, expect, vi } from 'vitest';
import request from 'supertest';
import { createHmac, randomBytes } from 'node:crypto';
vi.mock('@/config/env', async (original) => {
  const { ENV } = await original<typeof import('@/config/env')>();
  return { ENV: { ...ENV, API_GATEWAY_REQUIRED: true,
    API_GATEWAY_SECRET: 'app-gateway-unit-secret-not-a-real-credential', API_GATEWAY_AUDIENCE: 'emergency-response-staging-v1' } };
});
import app from '@/app';
function proof(path: string, method = 'GET', cookie = '', origin = '', referer = '', site = '') {
  const time = String(Date.now()); const nonce = randomBytes(16).toString('hex'); const ip = '192.0.2.99';
  const payload = JSON.stringify(['er-api-gateway-v1', 'emergency-response-staging-v1', time, nonce,
    method, path, ip, cookie, '', origin, referer, site]);
  return { 'x-er-gateway-ip': ip, 'x-er-gateway-time': time, 'x-er-gateway-nonce': nonce,
    'x-er-gateway-signature': createHmac('sha256', 'app-gateway-unit-secret-not-a-real-credential').update(payload).digest('hex'),
    ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}),
    ...(referer ? { referer } : {}), ...(site ? { 'sec-fetch-site': site } : {}) };
}
const apiPrefixes = ['/api', '/API', '/Api', '/aPi', '/apI', '/APi', '/aPI', '/ApI'];

it.each(apiPrefixes)('requires proof for every routed API spelling: %s', async (prefix) => {
  for (const suffix of ['', '/', '/auth/v1/me', '/events/v1/stream', '/incidents/v1/?limit=5',
    '/upload/v1/signature', '/alerts/v1/', '/not-a-route']) {
    const response = await request(app).get(prefix + suffix);
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Verified API gateway required');
    expect(response.headers['cache-control']).toBe('no-store');
  }
  for (const method of ['post', 'put', 'patch', 'delete', 'options', 'head'] as const) {
    const response = await request(app)[method](prefix + '/auth/v1/logout');
    expect(response.status).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
  }
});

it.each(apiPrefixes)('preserves authentication and exact signed URLs: %s', async (prefix) => {
  const privatePath = prefix + '/auth/v1/me';
  const authenticatedTransport = await request(app).get(privatePath)
    .set(proof(privatePath, 'GET', 'accessToken=invalid'));
  expect(authenticatedTransport.status).toBe(401);
  expect(authenticatedTransport.headers['cache-control']).toBe('no-store');
  expect(Object.keys(authenticatedTransport.headers).some(name => name.startsWith('x-er-gateway-'))).toBe(false);

  const publicPath = prefix + '/notifications/v1/web-push-key?format=raw%2Fvalue';
  expect((await request(app).get(publicPath).set(proof(publicPath))).status).toBe(200);
  const wrongPath = prefix + '/notifications/v1/web-push-key?format=raw%2fvalue';
  expect((await request(app).get(publicPath).set(proof(wrongPath))).status).toBe(403);
  if (prefix !== '/api') {
    expect((await request(app).get(privatePath).set(proof('/api/auth/v1/me'))).status).toBe(403);
  }
  const notFound = await request(app).get(prefix).set(proof(prefix));
  expect(notFound.status).toBe(404);
  expect(notFound.body.code).toBe(404);
  expect(notFound.headers['cache-control']).toBe('no-store');
});

it.each(apiPrefixes)('applies origin protection after valid proof: %s', async (prefix) => {
  const path = prefix + '/auth/v1/logout';
  for (const context of [
    { origin: 'https://untrusted.example', referer: '', site: '' },
    { origin: '', referer: 'https://untrusted.example/form', site: '' },
    { origin: '', referer: '', site: 'cross-site' },
  ]) {
    const response = await request(app).post(path)
      .set(proof(path, 'POST', '', context.origin, context.referer, context.site)).send({});
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Request origin is not allowed');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
  }
  const malformedPath = prefix + '/auth/v1/login';
  const malformed = await request(app).post(malformedPath)
    .set(proof(malformedPath, 'POST')).set('Content-Type', 'application/json').send('{');
  expect(malformed.status).toBe(400);
  expect(malformed.body.message).toBe('Invalid JSON request body');
});

it('does not expand the boundary to unrelated or encoded-prefix paths', async () => {
  for (const path of ['/apix/auth/v1/me', '/API-extra/auth/v1/me', '/%61pi/auth/v1/me', '/api%2Fauth/v1/me']) {
    const response = await request(app).get(path);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe(404);
  }
});
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
