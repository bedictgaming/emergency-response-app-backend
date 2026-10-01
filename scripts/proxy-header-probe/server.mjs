// Temporary header-only server. No application imports, DB clients or workers.
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

export const CONTEXT = 'emergency-response-staging-header-probe-2026-10-01-v1';
export const STAGING_SERVICE = '68b0de8b-47bc-4841-8d71-b1d60dd2d186';
export const STAGING_ENVIRONMENT = '76976f95-6258-48e7-9f07-cfcabda7d653';

export function probeToken(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('PROBE_SECRET_REQUIRED');
  return createHmac('sha256', secret).update(CONTEXT).digest('hex');
}

export function assertStaging(env) {
  if (env.RAILWAY_SERVICE_ID !== STAGING_SERVICE || env.RAILWAY_ENVIRONMENT_ID !== STAGING_ENVIRONMENT
    || env.RAILWAY_ENVIRONMENT_NAME !== 'staging'
    || new URL(env.DATABASE_URL).pathname !== '/emergency_staging_20260927_c6b212') {
    throw new Error('EXACT_SYNTHETIC_STAGING_REQUIRED');
  }
}

export function createProbeHandler(token, { now = Date.now, ttlMs = 15 * 60 * 1000, maxRequests = 30 } = {}) {
  const deadline = now() + ttlMs;
  let requests = 0;
  const opaque = value => createHmac('sha256', token).update(value).digest('hex').slice(0, 24);
  const parse = value => typeof value === 'string'
    ? value.split(',').map(part => part.trim()).filter(part => isIP(part)).slice(0, 8).map(opaque)
    : [];
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/readyz')) return send(200, { probeOnly: true });
    if (req.method !== 'GET' || req.url !== '/api/proxy-header-probe') return send(404, { code: 404 });
    if (now() >= deadline) return send(410, { code: 410 });
    const supplied = req.headers['x-diagnostic-authorization'];
    if (typeof supplied !== 'string' || supplied.length !== token.length
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return send(401, { code: 401 });
    if (++requests > maxRequests) return send(429, { code: 429 });
    const peer = req.socket.remoteAddress || '';
    return send(200, {
      probeOnly: true, sequence: requests,
      // Comparable only within this short run; never return raw addresses/headers.
      peer: opaque(peer), peerFamily: req.socket.remoteFamily,
      xForwardedFor: parse(req.headers['x-forwarded-for']),
      xRealIp: parse(req.headers['x-real-ip']),
      xVercelForwardedFor: parse(req.headers['x-vercel-forwarded-for']),
      forwardedPresent: typeof req.headers.forwarded === 'string',
      railwayEdgePresent: typeof req.headers['x-railway-edge'] === 'string',
      vercelDeploymentHeaderPresent: typeof req.headers['x-vercel-deployment-url'] === 'string',
    });
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertStaging(process.env);
    const handler = createProbeHandler(probeToken(process.env.JWT_SECRET));
    const server = http.createServer({ maxHeaderSize: 8192 }, handler);
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.listen(Number(process.env.PORT || 8000), '0.0.0.0', () => console.log('HEADER_ONLY_STAGING_PROBE_READY'));
  } catch { console.error('STAGING_PROBE_REFUSED'); process.exitCode = 1; }
}
