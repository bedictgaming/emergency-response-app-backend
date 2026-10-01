import type { Request, RequestHandler } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';

const prefix = 'x-er-gateway-';
const maxAgeMs = 60_000;
const futureSkewMs = 5_000;

/** Transport attestation only. Cookies, CSRF, account lookup and RBAC still run. */
export function createApiGatewayGuard({ required, secret, audience }: {
  required: boolean; secret: string; audience: string;
}, { now = Date.now, maxNonces = 20_000 } = {}): RequestHandler {
  if (required && (secret.length < 32 || !/^[a-z0-9-]{1,80}$/.test(audience))) {
    throw new Error('Invalid API gateway configuration');
  }
  const used = new Map<string, number>();
  let sweptAt = 0;
  return (req, res, next) => {
    if (!required) {
      for (const name of Object.keys(req.headers)) if (name.startsWith(prefix)) delete req.headers[name];
      return next();
    }
    const read = (name: string) => typeof req.headers[prefix + name] === 'string' ? req.headers[prefix + name] as string : '';
    const ip = read('ip');
    const time = read('time');
    const nonce = read('nonce');
    const signature = read('signature');
    const clock = now();
    const issued = Number(time);
    const metadataValid = isIP(ip) && /^\d{13}$/.test(time) && /^[a-f0-9]{32}$/.test(nonce)
      && /^[a-f0-9]{64}$/.test(signature) && clock - issued <= maxAgeMs && issued - clock <= futureSkewMs;
    const payload = JSON.stringify(['er-api-gateway-v1', audience, time, nonce, req.method,
      req.originalUrl, ip, req.get('cookie') || '', req.get('authorization') || '',
      req.get('origin') || '', req.get('referer') || '', req.get('sec-fetch-site') || '']);
    const expected = createHmac('sha256', secret).update(payload).digest();
    if (!metadataValid || !timingSafeEqual(Buffer.from(signature, 'hex'), expected)) {
      return res.status(403).json({ code: 403, status: 'error', message: 'Verified API gateway required' });
    }
    if (clock - sweptAt >= 1000) {
      for (const [key, expires] of used) if (expires < clock) used.delete(key);
      sweptAt = clock;
    }
    if (used.has(nonce)) return res.status(403).json({ code: 403, status: 'error', message: 'Verified API gateway required' });
    // Do not evict live entries and open a replay window when capacity is full.
    if (used.size >= maxNonces) {
      res.setHeader('Retry-After', '2');
      return res.status(503).json({ code: 503, status: 'error', message: 'API gateway temporarily unavailable' });
    }
    used.set(nonce, issued + maxAgeMs);
    // Express's proxy topology remains untrusted. Only authenticated metadata
    // supplies the single request IP used by quotas and existing audit callers.
    Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    Object.defineProperty(req, 'ips', { value: [ip], configurable: true });
    for (const name of Object.keys(req.headers)) if (name.startsWith(prefix)) delete req.headers[name];
    return next();
  };
}

// Preserve the installed limiter's IPv6 /56 grouping, including outside gateway mode.
export const clientIpRateLimitKey = (req: Request) => ipKeyGenerator(req.ip || 'unknown');
