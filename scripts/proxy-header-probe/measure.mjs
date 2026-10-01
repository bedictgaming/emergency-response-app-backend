import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { probeToken, assertStaging } from './server.mjs';

const cfg = JSON.parse(process.env.STAGING_HEADER_PROBE_CONFIG || '{}');
const preview = process.env.STAGING_HEADER_PROBE_PREVIEW;
const cli = process.env.STAGING_HEADER_PROBE_VERCEL_CLI;
const path = '/api/proxy-header-probe';
const staging = 'https://api-staging-staging-86d9.up.railway.app';

try {
  assertStaging(cfg);
  if (preview !== 'https://emergency-response-hqrl001w4-benedict-mequiabas-projects.vercel.app' || !cli) throw new Error('PROBE_PREVIEW_REQUIRED');
  const token = probeToken(cfg.JWT_SECRET);
  const opaque = value => createHmac('sha256', token).update(value).digest('hex').slice(0, 24);
  const fixtures = { ff: '192.0.2.201', real: '198.51.100.202', vercel: '203.0.113.203' };
  const cases = [
    ['baseline', {}],
    ['spoof-forwarded-for', { 'x-forwarded-for': fixtures.ff }],
    ['spoof-real-ip', { 'x-real-ip': fixtures.real }],
    ['spoof-vercel-forwarded-for', { 'x-vercel-forwarded-for': fixtures.vercel }],
    ['spoof-chain', { 'x-forwarded-for': `${fixtures.ff}, ${fixtures.real}` }],
    ['spoof-all', { 'x-forwarded-for': fixtures.ff, 'x-real-ip': fixtures.real, 'x-vercel-forwarded-for': fixtures.vercel, forwarded: `for=${fixtures.ff}` }],
  ];
  const unauthorized = await fetch(staging + path, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (unauthorized.status !== 401) throw new Error('PROBE_AUTH_NOT_ENFORCED');
  const results = [];
  for (const via of ['direct-railway', 'protected-vercel-proxy']) {
    let baseline;
    for (const [name, sent] of cases) {
      const headers = { ...sent, 'x-diagnostic-authorization': token };
      let body;
      if (via === 'direct-railway') {
        const response = await fetch(staging + path, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (response.status !== 200 || response.headers.get('cache-control') !== 'no-store') throw new Error('DIRECT_PROBE_FAILED');
        body = await response.json();
      } else {
        const args = [cli, 'curl', path, '--deployment', preview, '--', '--silent', '--show-error', '--max-time', '15'];
        for (const [key, value] of Object.entries(headers)) args.push('--header', `${key}: ${value}`);
        const response = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 45000, windowsHide: true });
        if (response.status !== 0) throw new Error('PROTECTED_PROXY_PROBE_FAILED');
        body = JSON.parse(response.stdout);
      }
      if (!body.probeOnly || !body.peer || !Array.isArray(body.xForwardedFor)) throw new Error('UNEXPECTED_PROBE_RESPONSE');
      baseline ??= body;
      results.push({ via, name, body });
      console.log(JSON.stringify({ via, name, success: true,
        rawSocketPeerSameAsBaseline: body.peer === baseline.peer,
        forwardedForEntries: body.xForwardedFor.length,
        realIpEntries: body.xRealIp.length,
        vercelForwardedForEntries: body.xVercelForwardedFor.length,
        injectedForwardedForRetained: body.xForwardedFor.includes(opaque(fixtures.ff)),
        injectedRealIpRetained: body.xRealIp.includes(opaque(fixtures.real)),
        injectedVercelIpRetained: body.xVercelForwardedFor.includes(opaque(fixtures.vercel)),
        realIpSameAsBaseline: JSON.stringify(body.xRealIp) === JSON.stringify(baseline.xRealIp),
        vercelIpSameAsBaseline: JSON.stringify(body.xVercelForwardedFor) === JSON.stringify(baseline.xVercelForwardedFor),
        forwardedHeaderPresent: body.forwardedPresent,
        railwayEdgePresent: body.railwayEdgePresent,
      }));
    }
  }
  const direct = results.find(result => result.via === 'direct-railway').body;
  const proxied = results.find(result => result.via === 'protected-vercel-proxy').body;
  console.log(JSON.stringify({ totalAuthenticatedRequests: results.length, unauthorizedRejected: true,
    // Raw peers are not rate-limit buckets: the installed limiter masks IPv6 /56.
    distinctRawSocketPeers: new Set(results.map(result => result.body.peer)).size,
    directAndProxiedRawSocketPeerSame: direct.peer === proxied.peer,
    directAndProxiedRealIpSame: JSON.stringify(direct.xRealIp) === JSON.stringify(proxied.xRealIp),
    noRawIpsCookiesTokensLogged: true, noDatabaseOrNotificationClients: true,
    notATwoEndUserOrSustainedLoadTest: true }));
} catch {
  console.error('SANITIZED_HEADER_PROBE_FAILED'); process.exitCode = 1;
}
