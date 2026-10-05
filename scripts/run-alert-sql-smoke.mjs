// Optional local PostgreSQL/WASM smoke, with NO production credentials/data.
// Install reviewed PGlite dependencies in a separate temporary directory; pass
// that exact directory. This does not certify native multi-session concurrency.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
const directory = process.argv[2];
if (!directory) throw new Error('Supply a dedicated temporary PGlite dependency directory');
const { PGlite } = await import(pathToFileURL(resolve(directory, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const { PGLiteSocketServer } = await import(pathToFileURL(resolve(directory, 'node_modules/@electric-sql/pglite-socket/dist/index.js')).href);
const db = await PGlite.create();
let socket;
async function snapshot(name) {
  const key = randomBytes(32), nonce = randomBytes(12);
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows;
  const data = {};
  for (const item of tables) data[item.table_name] = (await db.query(`SELECT * FROM "${item.table_name.replaceAll('"', '""')}"`)).rows;
  const plaintext = Buffer.from(JSON.stringify({ syntheticOnly: true, tables: data }));
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(), decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAuthTag(tag);
  if (!Buffer.concat([decipher.update(encrypted), decipher.final()]).equals(plaintext)) throw new Error('Synthetic snapshot authentication failed');
  await writeFile(resolve(directory, `${randomUUID()}-${name}`), Buffer.concat([nonce, tag, encrypted]), { flag: 'wx' }); key.fill(0); plaintext.fill(0);
}
try {
  await snapshot('empty-before-migrations.enc');
  const migrations = (await readdir(resolve('prisma/migrations'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const migration of migrations) {
    if (migration === '20261005093000_alert_attention') await snapshot('synthetic-before-alert-migration.enc');
    await db.exec(await readFile(resolve('prisma/migrations', migration, 'migration.sql'), 'utf8'));
  }
  socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 10, inspect: false, debug: false });
  let port;
  socket.addEventListener('listening', event => { port = event.detail.port; });
  await socket.start();
  if (!Number.isInteger(port) || port < 1) throw new Error('Loopback test listener unavailable');
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/alert_disposable?sslmode=disable`;
  const safe = {};
  for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','TEMP','TMP','APPDATA','LOCALAPPDATA']) if (process.env[key]) safe[key] = process.env[key];
  const env = { ...safe, NODE_ENV: 'test', DATABASE_URL: url, DISPOSABLE_DATABASE_URL: url, CONFIRM_DISPOSABLE_DATABASE: 'alert_disposable',
    RUN_ALERT_DATABASE_TESTS: '1', BACKGROUND_JOBS_ENABLED: 'false', EVIDENCE_DELETION_ENABLED: 'false', ORPHAN_EVIDENCE_SWEEP_ENABLED: 'false', API_GATEWAY_REQUIRED: 'false',
    API_GATEWAY_SECRET: '', API_GATEWAY_AUDIENCE: '', TRUSTED_PROXY_CIDRS: '', RAILWAY_ENVIRONMENT_NAME: '', EVIDENCE_NAMESPACE: 'emergency-incidents-staging',
    JWT_SECRET: 'synthetic-alert-test-only-secret-not-live', FRONTEND_URL: 'http://localhost:3000', BACKEND_URL: 'http://localhost:8000', COOKIE_DOMAIN: '',
    CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '', WEB_PUSH_PUBLIC_KEY: '', WEB_PUSH_PRIVATE_KEY: '', GEMINI_API_KEY: '',
    GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '', SMTP_FROM: '' };
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', 'tests/alert-database.integration.test.ts', '--maxWorkers=1'], { env, stdio: 'inherit' });
    child.on('error', reject); child.on('close', resolveResult);
  });
  process.exitCode = result ?? 1;
  console.log('Local embedded-SQL smoke finished; native concurrency and provider/device acceptance are separate gates.');
} finally { if (socket) await socket.stop(); await db.close(); }
