// Operator-only, non-mutating protocol/limiter check. No report, account, email,
// upload or notification request is made. Credentials remain in memory.
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { assertStaging } from './proxy-header-probe/server.mjs';

const cfg = JSON.parse(process.env.STAGING_GATEWAY_CHECK_CONFIG || '{}');
const preview = process.env.STAGING_GATEWAY_CHECK_PREVIEW;
const cli = process.env.STAGING_GATEWAY_CHECK_VERCEL_CLI;
const base = 'https://api-staging-staging-86d9.up.railway.app';
function must(condition, label) { if (!condition) throw new Error(label); }
function proof(path, method = 'GET', ip = '192.0.2.201', extra = {}, issued = Date.now()) {
  const time = String(issued); const nonce = randomBytes(16).toString('hex');
  const payload = JSON.stringify(['er-api-gateway-v1', cfg.API_GATEWAY_AUDIENCE, time, nonce,
    method, path, ip, extra.cookie || '', extra.authorization || '', extra.origin || '',
    extra.referer || '', extra['sec-fetch-site'] || '']);
  return { ...extra, 'x-er-gateway-ip': ip, 'x-er-gateway-time': time, 'x-er-gateway-nonce': nonce,
    'x-er-gateway-signature': createHmac('sha256', cfg.API_GATEWAY_SECRET).update(payload).digest('hex') };
}
async function direct(path, options = {}) {
  const response = await fetch(base + path, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  must(response.headers.get('cache-control') === 'no-store', 'DIRECT_CACHE_POLICY');
  await response.arrayBuffer();
  return response.status;
}
async function via(path, { headers = {}, body } = {}) {
  const args = [cli, 'curl', path, '--deployment', preview, '--', '--silent', '--show-error', '--include', '--max-time', '20'];
  for (const [key, value] of Object.entries(headers)) args.push('--header', `${key}: ${value}`);
  if (body !== undefined) args.push('--request', 'POST', '--header', 'Content-Type: application/json', '--data-raw', body);
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI_TIMEOUT')); }, 45000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('CLI_FAILED')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || stdout.length > 100000 || stderr.length > 100000) reject(new Error('CLI_FAILED'));
      else resolve(stdout);
    });
  });
  const status = Number([...output.matchAll(/^HTTP\/[^\s]+\s+(\d+)/gm)].at(-1)?.[1]);
  must(status > 0 && /cache-control:\s*no-store/i.test(output), 'PROXY_RESPONSE_POLICY');
  must(!/^x-(?:er-gateway|middleware-request-x-er-gateway)-/im.test(output), 'PROOF_RESPONSE_LEAK');
  // Never return or log raw headers/body/cookies.
  return { status, secureStateCookie: /^set-cookie:\s*google_oauth_state=.*;\s*HttpOnly;\s*Secure/im.test(output)
    && !/^set-cookie:\s*google_oauth_state=.*;\s*Domain=/im.test(output) };
}
try {
  assertStaging(cfg);
  must(cfg.API_GATEWAY_REQUIRED === 'true' && cfg.API_GATEWAY_AUDIENCE === 'emergency-response-staging-v1'
    && cfg.BACKGROUND_JOBS_ENABLED === 'false' && cfg.API_GATEWAY_SECRET?.length >= 32
    && !cfg.TRUSTED_PROXY_CIDRS, 'STAGING_GATEWAY_MODE_REQUIRED');
  must(preview === 'https://emergency-response-6mpeihbjc-benedict-mequiabas-projects.vercel.app' && cli, 'EXACT_PREVIEW_REQUIRED');
  const me = '/api/auth/v1/me';
  for (const headers of [{}, { 'x-vercel-forwarded-for': '192.0.2.99' },
    { 'x-forwarded-for': '192.0.2.99', 'x-real-ip': '192.0.2.99' },
    { ...proof(me), 'x-er-gateway-signature': '0'.repeat(64) }]) {
    must(await direct(me, { headers }) === 403, 'DIRECT_FORGERY_ACCEPTED');
  }
  const once = proof(me);
  must(await direct(me, { headers: once }) === 401, 'AUTHENTICATION_REMOVED');
  must(await direct(me, { headers: once }) === 403, 'REPLAY_ACCEPTED');
  must(await direct(me, { headers: proof(me, 'GET', '192.0.2.201', {}, Date.now() - 65000) }) === 403, 'STALE_ACCEPTED');
  console.log(JSON.stringify({ directForgeryReplayAndExpiryRejected: true, gatewayIsNotUserAuthentication: true }));
  for (const headers of [{}, { 'x-vercel-forwarded-for': '192.0.2.99' }, { 'x-real-ip': '192.0.2.99' },
    { 'x-forwarded-for': '192.0.2.99' }, { 'x-er-gateway-signature': 'forged', 'x-er-gateway-ip': '192.0.2.99' },
    { cookie: 'accessToken=invalid; refreshToken=invalid' }]) {
    must((await via(me, { headers })).status === 401, 'PROXY_PROTOCOL_OR_AUTH_FAILED');
  }
  for (const path of ['/api/incidents/v1/', '/api/incidents/v1?limit=5&includeTotal=false', '/api/events/v1/stream']) {
    must((await via(path)).status === 401, 'PATH_OR_QUERY_SIGNING_FAILED');
  }
  const oauth = await via('/api/auth/v1/google');
  must(oauth.status === 302 && oauth.secureStateCookie, 'OAUTH_COOKIE_FORWARDING_FAILED');
  console.log(JSON.stringify({ protectedProxyReplacesSpoofedMetadata: true, cookieQuerySlashAndSseAuthPreserved: true,
    oauthSecureHostOnlyStateCookiePreserved: true, noInternalProofHeadersExposed: true }));
  const login = '/api/auth/v1/login';
  // Actual application limiter, using two authenticated synthetic gateway assertions.
  // Empty login objects fail validation before any database/authentication/email action.
  for (let i = 0; i < 30; i++) {
    must(await direct(login, { method: 'POST', headers: { ...proof(login, 'POST'), 'content-type': 'application/json' }, body: '{}' }) === 400, 'SYNTHETIC_LIMITER_SETUP_FAILED');
  }
  must(await direct(login, { method: 'POST', headers: { ...proof(login, 'POST'),
    'x-vercel-forwarded-for': '198.51.100.202', 'content-type': 'application/json' }, body: '{}' }) === 429, 'FORGED_PROVIDER_HEADER_RESET_QUOTA');
  must(await direct(login, { method: 'POST', headers: { ...proof(login, 'POST', '198.51.100.202'),
    'content-type': 'application/json' }, body: '{}' }) === 400, 'SYNTHETIC_CLIENTS_SHARE_QUOTA');
  console.log(JSON.stringify({ actualBackendLimiterSeparatesSignedSyntheticClientIps: true, forgedProviderHeaderCannotResetQuota: true }));
  // A separate real Vercel ingress IP must likewise retain its allowance under
  // spoofed client headers. This is still one originating PC, not two devices.
  for (let wave = 0; wave < 10; wave++) {
    const responses = await Promise.all([0, 1, 2].map(n => via(login, { body: '{}',
      headers: { 'x-vercel-forwarded-for': `192.0.2.${wave * 3 + n + 1}` } })));
    must(responses.every(res => res.status === 400), 'REAL_PROXY_LIMITER_SETUP_FAILED');
    if ((wave + 1) % 3 === 0) console.log(JSON.stringify({ protectedProxyInvalidLoginChecksCompleted: (wave + 1) * 3 }));
  }
  must((await via(login, { body: '{}', headers: { 'x-vercel-forwarded-for': '203.0.113.99', 'x-real-ip': '203.0.113.99' } })).status === 429, 'PROXY_FORGERY_RESET_QUOTA');
  console.log(JSON.stringify({ realProtectedProxyQuotaSurvivesSpoofing: true, passed: true,
    noAccountReportUploadOrNotificationWrites: true, notTwoIndependentEndUserDevices: true }));
} catch (error) {
  const label = /^[A-Z_]{1,80}$/.test(error.message || '') ? error.message : 'CHECK_FAILED';
  console.error(JSON.stringify({ passed: false, reason: label })); process.exitCode = 1;
}
