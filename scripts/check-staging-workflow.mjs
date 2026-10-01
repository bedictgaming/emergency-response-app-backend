// Operator-only bounded live workflow. Synthetic staging data only. No migrations,
// SMTP messages, push subscriptions, production rows or production evidence changes.
import { randomUUID, randomBytes, createHmac, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import pg from 'pg';
import { v2 as cloudinary } from 'cloudinary';
import { assertStaging } from './proxy-header-probe/server.mjs';

const cfg = JSON.parse(process.env.STAGING_WORKFLOW_CONFIG || '{}');
const preview = 'https://emergency-response-6mpeihbjc-benedict-mequiabas-projects.vercel.app';
const base = 'https://api-staging-staging-86d9.up.railway.app';
const cli = process.env.STAGING_WORKFLOW_VERCEL_CLI;
const runId = randomUUID();
const users = [], types = [], incidents = [], locations = [], assets = [], streams = [];
let prisma, client, createdBarangay, cleanupFailed = false;
function must(value, label) { if (!value) throw new Error(label); }
function proof(path, method, cookie = '') {
  const headers = { origin: cfg.FRONTEND_URL, cookie, 'content-type': 'application/json' };
  const time = String(Date.now()), nonce = randomBytes(16).toString('hex'), ip = '192.0.2.207';
  const payload = JSON.stringify(['er-api-gateway-v1', cfg.API_GATEWAY_AUDIENCE, time, nonce,
    method, path, ip, cookie, '', headers.origin, '', '']);
  return { ...headers, 'x-er-gateway-time': time, 'x-er-gateway-nonce': nonce, 'x-er-gateway-ip': ip,
    'x-er-gateway-signature': createHmac('sha256', cfg.API_GATEWAY_SECRET).update(payload).digest('hex') };
}
function mergeCookies(previous, values) {
  const jar = new Map(previous.split('; ').filter(Boolean).map(pair => [pair.split('=')[0], pair]));
  for (const value of values) { const pair = value.split(';')[0]; jar.set(pair.split('=')[0], pair); }
  return [...jar.values()].join('; ');
}
async function direct(path, account, body) {
  const method = body === undefined ? 'GET' : 'POST';
  const response = await fetch(base + path, { method, headers: proof(path, method, account?.cookie),
    ...(body !== undefined && { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(30000) });
  must(response.headers.get('cache-control') === 'no-store', 'CACHE_POLICY');
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, headers: response.headers, cookies: response.headers.getSetCookie() };
}
async function via(path, account, body) {
  const args = [cli, 'curl', path, '--deployment', preview, '--', '--silent', '--show-error', '--include', '--max-time', '30'];
  args.push('--header', `Cookie: ${account.cookie}`, '--header', `Origin: ${cfg.FRONTEND_URL}`);
  if (body !== undefined) args.push('--request', 'POST', '--header', 'Content-Type: application/json', '--data-raw', JSON.stringify(body));
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true });
    let stdout = '', size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('PROXY_TIMEOUT')); }, 45000);
    child.stdout.on('data', data => { size += data.length; if (size <= 1_000_000) stdout += data; });
    child.stderr.on('data', () => {}); // Never log CLI credential-bearing output.
    child.on('error', () => { clearTimeout(timer); reject(new Error('PROXY_FAILED')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && size < 1_000_000 ? resolve(stdout) : reject(new Error('PROXY_FAILED')); });
  });
  const status = Number([...output.matchAll(/^HTTP\/[^\s]+\s+(\d+)/gm)].at(-1)?.[1]);
  must(/cache-control:\s*no-store/i.test(output), 'PROXY_CACHE_POLICY');
  const content = output.slice(output.lastIndexOf('\r\n\r\n') + 4);
  let json = null; try { json = JSON.parse(content); } catch {}
  const cookies = [...output.matchAll(/^set-cookie:\s*(.+)\r?$/gim)].map(match => match[1].trim());
  return { status, json, cookies };
}
async function openStream(account) {
  const abort = new AbortController();
  const response = await fetch(base + '/api/events/v1/stream', { headers: proof('/api/events/v1/stream', 'GET', account.cookie), signal: abort.signal });
  must(response.status === 200 && response.headers.get('content-type')?.includes('text/event-stream'), 'SSE_AUTH_FAILED');
  const reader = response.body.getReader(), events = [], decoder = new TextDecoder();
  let buffer = '', connected = false;
  const loop = (async () => {
    try { while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      while (buffer.includes('\n\n')) {
        const index = buffer.indexOf('\n\n'), frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const type = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
        if (type === 'connected') connected = true;
        if (type && data && type !== 'connected') events.push({ type, id: JSON.parse(data).entityId, at: performance.now() });
      }
    } } catch { if (!abort.signal.aborted) throw new Error('SSE_INTERRUPTED'); }
  })();
  // Register immediately so even handshake failure closes the reader.
  const stream = { events, close: async () => { abort.abort(); await loop; } }; streams.push(stream);
  const deadline = Date.now() + 8000;
  while (!connected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  must(connected, 'SSE_HANDSHAKE_TIMEOUT'); return stream;
}
async function openProxyStream(account) {
  const args = [cli, 'curl', '/api/events/v1/stream', '--deployment', preview, '--',
    '--silent', '--show-error', '--include', '--no-buffer', '--max-time', '60',
    '--header', `Cookie: ${account.cookie}`, '--header', `Origin: ${cfg.FRONTEND_URL}`];
  const child = spawn(process.execPath, args, { windowsHide: true });
  const events = [], decoder = new TextDecoder();
  let buffer = '', connected = false, failed = false, closed = false;
  const completion = new Promise(resolve => { child.on('close', () => { closed = true; resolve(); }); });
  child.stderr.on('data', () => {});
  child.on('error', () => { failed = true; });
  child.stdout.on('data', data => {
    buffer += decoder.decode(data, { stream: true }).replace(/\r\n/g, '\n');
    while (buffer.includes('\n\n')) {
      const index = buffer.indexOf('\n\n'), frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      if (frame.startsWith('HTTP/')) {
        if (!/^HTTP\/[^\s]+\s+200/m.test(frame) || !/content-type:\s*text\/event-stream/i.test(frame)) failed = true;
      }
      const type = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
      if (type === 'connected') connected = true;
      if (type && data && type !== 'connected') {
        try { events.push({ type, id: JSON.parse(data).entityId, at: performance.now() }); }
        catch { failed = true; }
      }
    }
  });
  const stream = { events, close: async () => { if (!closed) child.kill(); await completion; } };
  streams.push(stream);
  const deadline = Date.now() + 12000;
  while (!connected && !failed && !closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  must(connected && !failed && !closed, 'PROXY_SSE_HANDSHAKE_FAILED'); return stream;
}
// Distinct deterministic, valid PNG fixtures; never citizen evidence. No image file on disk.
function png(index) {
  function crc(buffer) { let value = 0xffffffff; for (const byte of buffer) { value ^= byte; for (let n = 0; n < 8; n++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
  function chunk(name, data) { const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([type, data]))); return Buffer.concat([length, type, data, checksum]); }
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(32 * (1 + 32 * 3));
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const offset = y * 97 + 1 + x * 3;
    pixels[offset] = (x * (index + 3) + y * 7) % 256; pixels[offset + 1] = (y * (index + 13) + x * 11) % 256; pixels[offset + 2] = index * 40;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
try {
  assertStaging(cfg);
  must(cfg.API_GATEWAY_REQUIRED === 'true' && cfg.BACKGROUND_JOBS_ENABLED === 'false'
    && cfg.EVIDENCE_NAMESPACE === 'emergency-incidents-staging' && cfg.EVIDENCE_DELETION_ENABLED === 'false'
    && cfg.ORPHAN_EVIDENCE_SWEEP_ENABLED === 'false' && cli, 'STAGING_CONTAINMENT_REQUIRED');
  const url = new URL(cfg.DATABASE_URL); for (const key of ['sslmode', 'sslrootcert']) url.searchParams.delete(key);
  client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true } }); await client.connect();
  must((await client.query('select current_database() as name')).rows[0].name === 'emergency_staging_20260927_c6b212', 'WRONG_DATABASE');
  const counts = await client.query('select (select count(*) from "User")::int as users, (select count(*) from incidents)::int as incidents');
  must(counts.rows[0].users === 0 && counts.rows[0].incidents === 0, 'STAGING_NOT_EMPTY');
  await client.end(); client = null;
  for (const [key, value] of Object.entries(cfg)) if (typeof value === 'string') process.env[key] = value;
  ({ prisma } = await import('../dist/lib/prisma.js'));
  const { hashPassword } = await import('../dist/utils/password.js');
  const password = `Synthetic-${randomBytes(24).toString('hex')}!`;
  const accounts = {};
  for (const department of ['MAIN', 'FIRE', 'MEDICAL', 'POLICE', 'DRRMO', 'CITIZEN0', 'CITIZEN1', 'CITIZEN2']) {
    const citizen = department.startsWith('CITIZEN');
    const email = `staging-workflow-${department}-${runId}@example.invalid`;
    const user = await prisma.user.create({ data: { email, name: 'SYNTHETIC STAGING TEST — DO NOT DISPATCH',
      password: hashPassword(password), emailVerified: new Date(), role: citizen ? 'USER' : 'ADMIN',
      ...(citizen ? {} : { department, isMainAdmin: department === 'MAIN' }) }, select: { id: true } });
    users.push(user.id);
    const account = { id: user.id, cookie: '' }; accounts[department] = account;
    const login = await via('/api/auth/v1/login', account, { email, password });
    must(login.status === 200, 'PROXY_LOGIN_FAILED'); account.cookie = mergeCookies('', login.cookies);
    must(login.cookies.some(value => /^accessToken=/.test(value) && /HttpOnly/i.test(value) && /Secure/i.test(value) && !/Domain=/i.test(value)), 'COOKIE_FLAGS_FAILED');
    must((await via('/api/auth/v1/me', account)).json?.data?.user?.id === user.id, 'PROXY_SESSION_FAILED');
  }
  must((await via('/api/users/v1/', accounts.CITIZEN0)).status === 403, 'CITIZEN_ADMIN_ACCESS');
  const originalCookies = accounts.CITIZEN0.cookie;
  const renewal = await via('/api/auth/v1/refresh-token', accounts.CITIZEN0, {});
  must(renewal.status === 200, 'REFRESH_FAILED'); accounts.CITIZEN0.cookie = mergeCookies(originalCookies, renewal.cookies);
  must((await via('/api/auth/v1/refresh-token', { cookie: originalCookies }, {})).status === 401, 'REFRESH_REPLAY_ACCEPTED');
  // Create a new synthetic citizen session after the replay check.
  // Recover credentials only from this run's account, never an existing account.
  const fresh = await via('/api/auth/v1/login', { cookie: '' }, { email: `staging-workflow-CITIZEN0-${runId}@example.invalid`, password });
  must(fresh.status === 200, 'RELOGIN_FAILED'); accounts.CITIZEN0.cookie = mergeCookies('', fresh.cookies);
  let barangay = await prisma.barangay.findUnique({ where: { name: 'Gabi' } });
  if (!barangay) { barangay = await prisma.barangay.create({ data: { name: 'Gabi', status: 'ACTIVE' } }); createdBarangay = barangay.barangayId; }
  must(barangay.status === 'ACTIVE', 'TEST_BARANGAY_INACTIVE');
  cloudinary.config({ cloud_name: cfg.CLOUDINARY_CLOUD_NAME, api_key: cfg.CLOUDINARY_API_KEY, api_secret: cfg.CLOUDINARY_API_SECRET, secure: true });
  const services = ['FIRE', 'MEDICAL', 'POLICE', 'HAZARD', 'MULTI'];
  const matching = { FIRE: ['FIRE'], MEDICAL: ['MEDICAL'], POLICE: ['POLICE'], HAZARD: ['DRRMO'], MULTI: ['MEDICAL', 'DRRMO'] };
  const departmentStreams = {};
  const timings = [];
  for (const [index, service] of services.entries()) {
    const reporter = accounts[`CITIZEN${Math.floor(index / 2)}`];
    const type = await prisma.incidentType.create({ data: { typeName: `Synthetic ${service === 'MULTI' ? 'General' : service} ${runId}` } }); types.push(type.typeId);
    const signature = await via('/api/upload/v1/signature', reporter, {}); must(signature.status === 200 && signature.json?.data, 'UPLOAD_SIGNATURE_FAILED');
    const params = signature.json.data;
    must(params.folder === `emergency-incidents-staging/${reporter.id}` && params.type === 'authenticated' && params.overwrite === false, 'UPLOAD_NAMESPACE_FAILED');
    const image = png(index + 1);
    const form = new FormData(); form.set('file', new Blob([image], { type: 'image/png' }), 'synthetic-test.png');
    for (const name of ['timestamp', 'folder', 'allowed_formats', 'signature', 'type']) form.set(name, String(params[name]));
    form.set('api_key', params.apiKey); form.set('public_id', params.publicId); form.set('overwrite', 'false');
    const upload = await fetch(`https://api.cloudinary.com/v1_1/${params.cloudName}/image/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    must(upload.ok, 'DIRECT_UPLOAD_FAILED'); const asset = await upload.json();
    must(asset.public_id?.startsWith(`${params.folder}/`) && asset.asset_id, 'ASSET_NAMESPACE_FAILED');
    assets.push({ publicId: asset.public_id, assetId: asset.asset_id });
    must(asset.public_id === `${params.folder}/${params.publicId}`, 'ASSET_IDENTITY_FAILED');
    const body = { title: `SYNTHETIC STAGING ${service} — NOT AN EMERGENCY ${runId}`, description: 'Automated isolated test. DO NOT DISPATCH.',
      category: service === 'MULTI' ? 'other' : service.toLowerCase(), typeId: type.typeId, barangayId: barangay.barangayId,
      latitude: 10.262 + index * 0.001, longitude: 123.958, reporterPhone: '0000000000',
      ...(service === 'MULTI' && { requestedServices: ['MEDICAL', 'HAZARD'] }), proofAttachment: { publicId: asset.public_id, fileName: 'synthetic-test.png' } };
    // The application intentionally closes SSE connections after 60 seconds.
    // Reconnect before each case instead of testing expired readers as live ones.
    for (const department of ['MAIN', 'FIRE', 'MEDICAL', 'POLICE', 'DRRMO']) {
      if (departmentStreams[department]) await departmentStreams[department].close();
      departmentStreams[department] = await openStream(accounts[department]);
    }
    const proxyStream = await openProxyStream(accounts.MAIN);
    const start = performance.now();
    const created = await via('/api/incidents/v1/', reporter, body); must(created.status === 201, 'REPORT_CREATE_FAILED');
    const submitMs = Math.round(performance.now() - start);
    const incident = created.json?.data?.incident; must(incident?.incidentId, 'REPORT_RESPONSE_FAILED');
    incidents.push(incident.incidentId); locations.push(incident.locationId);
    const recipients = ['MAIN', ...matching[service]];
    const deadline = Date.now() + 10000;
    while ((recipients.some(dept => !departmentStreams[dept].events.some(event => event.id === incident.incidentId))
      || !proxyStream.events.some(event => event.id === incident.incidentId)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    must(proxyStream.events.some(event => event.id === incident.incidentId), 'PROXY_SSE_EVENT_FAILED');
    await proxyStream.close();
    for (const department of ['MAIN', 'FIRE', 'MEDICAL', 'POLICE', 'DRRMO']) {
      const selected = recipients.includes(department);
      must(departmentStreams[department].events.some(event => event.id === incident.incidentId) === selected, 'SSE_DEPARTMENT_SCOPE_FAILED');
      const detail = await direct(`/api/incidents/v1/${incident.incidentId}`, accounts[department]);
      must(detail.status === (selected ? 200 : 403), 'DETAIL_DEPARTMENT_SCOPE_FAILED');
      const list = await direct('/api/incidents/v1/?limit=20&includeAttachments=true', accounts[department]);
      must(list.status === 200 && list.json.data.incidents.some(item => item.incidentId === incident.incidentId) === selected, 'LIST_DEPARTMENT_SCOPE_FAILED');
    }
    const attachment = incident.attachments?.[0]; must(attachment?.attachmentId, 'ATTACHMENT_MISSING');
    const photo = await direct(`/api/attachments/v1/${attachment.attachmentId}/content`, accounts[matching[service][0]]);
    must(photo.status === 302, 'EVIDENCE_REDIRECT_FAILED');
    const target = new URL(photo.headers.get('location')); must(target.hostname === 'api.cloudinary.com' && target.pathname.includes(`/${cfg.CLOUDINARY_CLOUD_NAME}/`), 'EVIDENCE_TARGET_FAILED');
    const download = await fetch(target, { signal: AbortSignal.timeout(15000) }); must(download.ok && download.headers.get('content-type')?.startsWith('image/'), 'EVIDENCE_DOWNLOAD_FAILED');
    must(createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex') === createHash('sha256').update(image).digest('hex'), 'EVIDENCE_BYTES_CHANGED');
    timings.push({ service, submitMs, eventMs: Math.round(Math.max(...recipients.map(dept => departmentStreams[dept].events.find(event => event.id === incident.incidentId).at - start))) });
    console.log(JSON.stringify({ service, hostedProxyReportAndPrivateEvidencePassed: true, selectedAndUnselectedDepartmentReadsAndDirectSsePassed: true, hostedProxySsePassed: true }));
  }
  must((await via('/api/auth/v1/logout', accounts.CITIZEN2, {})).status === 200, 'LOGOUT_FAILED');
  must((await via('/api/auth/v1/me', accounts.CITIZEN2)).status === 401, 'LOGOUT_SESSION_LIVE');
  console.log(JSON.stringify({ passed: true, timings, browserOAuthPushAndSustainedLoadNotCertified: true }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, reason: /^[A-Z_]{1,80}$/.test(error.message || '') ? error.message : 'WORKFLOW_FAILED' })); process.exitCode = 1;
} finally {
  await Promise.allSettled(streams.map(stream => stream.close()));
  if (prisma) {
    try {
      const persisted = await prisma.incident.findMany({ where: { reportedBy: { in: users }, title: { contains: runId } }, select: { incidentId: true, locationId: true } });
      incidents.push(...persisted.map(item => item.incidentId)); locations.push(...persisted.map(item => item.locationId));
      await prisma.attachment.deleteMany({ where: { incidentId: { in: incidents } } });
      await prisma.incident.deleteMany({ where: { incidentId: { in: incidents } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
      await prisma.assetCleanupJob.deleteMany({ where: { publicId: { in: assets.map(asset => asset.publicId) } } });
      await prisma.location.deleteMany({ where: { locationId: { in: locations } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.incidentType.deleteMany({ where: { typeId: { in: types } } });
      if (createdBarangay) await prisma.barangay.delete({ where: { barangayId: createdBarangay } });
      // Only assets created by this run, guarded by namespace AND immutable ID.
      for (const asset of assets) {
        must(asset.publicId.startsWith('emergency-incidents-staging/'), 'CLEANUP_NAMESPACE_FAILED');
        const current = await cloudinary.api.resource(asset.publicId, { resource_type: 'image', type: 'authenticated' });
        must(current.asset_id === asset.assetId, 'CLEANUP_ASSET_ID_CHANGED');
        must((await cloudinary.uploader.destroy(asset.publicId, { type: 'authenticated', invalidate: true })).result === 'ok', 'TEST_ASSET_CLEANUP_FAILED');
      }
    } catch { cleanupFailed = true; process.exitCode = 1; }
    await prisma.$disconnect();
  }
  if (client) await client.end();
  console.log(JSON.stringify({ exactSyntheticFixtureCleanupPassed: !cleanupFailed, preservedHistoricalCleanupJobs: true, productionNotModified: true }));
}
