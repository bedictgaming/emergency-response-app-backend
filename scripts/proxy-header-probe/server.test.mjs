import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { assertStaging, createProbeHandler, probeToken, STAGING_SERVICE, STAGING_ENVIRONMENT } from './server.mjs';

test('refuses production, wrong service and wrong database', () => {
  const env = { RAILWAY_SERVICE_ID: STAGING_SERVICE, RAILWAY_ENVIRONMENT_ID: STAGING_ENVIRONMENT,
    RAILWAY_ENVIRONMENT_NAME: 'staging', DATABASE_URL: 'postgresql://test:test@localhost/emergency_staging_20260927_c6b212' };
  assert.doesNotThrow(() => assertStaging(env));
  for (const patch of [{ RAILWAY_ENVIRONMENT_NAME: 'production' }, { RAILWAY_SERVICE_ID: 'other' },
    { RAILWAY_ENVIRONMENT_ID: 'production' }, { DATABASE_URL: 'postgresql://test:test@localhost/neondb' }]) {
    assert.throws(() => assertStaging({ ...env, ...patch }));
  }
  assert.throws(() => probeToken('short'));
});
test('authenticated, bounded, expiring diagnostics never echo sensitive headers or raw IPs', async () => {
  let clock = 0;
  const token = probeToken('unit-test-secret'.repeat(3));
  const server = createServer(createProbeHandler(token, { now: () => clock, ttlMs: 100, maxRequests: 2 }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-diagnostic-authorization': token, 'x-forwarded-for': '192.0.2.123, 198.51.100.8',
    cookie: 'private-cookie', authorization: 'private-token' };
  try {
    assert.equal((await fetch(`${base}/api/proxy-header-probe`)).status, 401);
    assert.equal((await fetch(`${base}/api/proxy-header-probe`, { method: 'POST', headers })).status, 404);
    const first = await fetch(`${base}/api/proxy-header-probe`, { headers });
    assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
    const body = await first.json();
    assert.equal(body.xForwardedFor.length, 2);
    assert.doesNotMatch(JSON.stringify(body), /192\.0\.2\.123|198\.51\.100\.8|private-cookie|private-token/);
    const second = await (await fetch(`${base}/api/proxy-header-probe`, { headers })).json();
    assert.deepEqual(second.xForwardedFor, body.xForwardedFor);
    assert.equal((await fetch(`${base}/api/proxy-header-probe`, { headers })).status, 429);
    clock = 101;
    assert.equal((await fetch(`${base}/api/proxy-header-probe`, { headers })).status, 410);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    assert.equal((await fetch(`${base}/api/incidents/v1/`, { headers })).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
