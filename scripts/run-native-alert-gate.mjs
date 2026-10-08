// Provider-free native PostgreSQL gate. Never accepts an application database.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import pg from 'pg';

const supplied = process.env.DISPOSABLE_DATABASE_URL;
let client;
try {
  const url = new URL(supplied || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.pathname !== '/alert_disposable' || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
      || [process.env.DATABASE_URL, process.env.DIRECT_URL].filter(Boolean).some(value => value !== supplied)) throw new Error('DISPOSABLE_LOOPBACK_TARGET_REQUIRED');
  client = new pg.Client({ connectionString: supplied, connectionTimeoutMillis: 5000 });
  await client.connect();
  const identity = (await client.query('SELECT current_database() AS name, version() AS version')).rows[0];
  if (identity.name !== 'alert_disposable' || !identity.version.startsWith('PostgreSQL ')) throw new Error('NATIVE_TARGET_MISMATCH');
  const initial = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  if (initial.rowCount !== 0) throw new Error('EMPTY_DISPOSABLE_DATABASE_REQUIRED');
  const directory = await mkdtemp(join(tmpdir(), 'alert-native-gate-')), key = randomBytes(32);
  async function snapshot(label) {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows;
    const data = {};
    for (const { table_name: table } of tables) data[table] = (await client.query(`SELECT * FROM "${table.replaceAll('"', '""')}"`)).rows;
    await client.query('COMMIT');
    const plaintext = Buffer.from(JSON.stringify({ syntheticOnly: true, tables: data }));
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const file = join(directory, `${label}.enc`);
    await writeFile(file, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
    const saved = await readFile(file), decipher = createDecipheriv('aes-256-gcm', key, saved.subarray(0, 12));
    decipher.setAuthTag(saved.subarray(12, 28));
    const recovered = Buffer.concat([decipher.update(saved.subarray(28)), decipher.final()]);
    if (!recovered.equals(plaintext)) throw new Error('SYNTHETIC_BACKUP_AUTHENTICATION_FAILED');
    recovered.fill(0); plaintext.fill(0);
  }
  await snapshot('empty-before-migrations');
  const migrations = (await readdir(resolve('prisma/migrations'), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort();
  for (const migration of migrations) {
    if (migration === '20261005093000_alert_attention') await snapshot('before-alert-migration');
    if (migration === '20261009090000_google_account_linking') await snapshot('before-google-link-migration');
    await client.query(await readFile(resolve('prisma/migrations', migration, 'migration.sql'), 'utf8'));
  }
  key.fill(0);
  // Whitelist the child's environment. No inherited provider/application secrets.
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, {
    NODE_ENV: 'test', DATABASE_URL: supplied, DIRECT_URL: supplied, DISPOSABLE_DATABASE_URL: supplied,
    CONFIRM_DISPOSABLE_DATABASE: 'alert_disposable', RUN_ALERT_DATABASE_TESTS: '1', RUN_NATIVE_ALERT_RACES: '1',
    RUN_NATIVE_GOOGLE_LINK_TESTS: '1', GOOGLE_ACCOUNT_LINKING_ENABLED: 'true',
    RUN_DATABASE_TESTS: '0', RUN_DISPOSABLE_DELIVERY_TESTS: '0', BACKGROUND_JOBS_ENABLED: 'false',
    EVIDENCE_DELETION_ENABLED: 'false', ORPHAN_EVIDENCE_SWEEP_ENABLED: 'false', API_GATEWAY_REQUIRED: 'false',
    API_GATEWAY_SECRET: '', API_GATEWAY_AUDIENCE: '', TRUSTED_PROXY_CIDRS: '', RAILWAY_ENVIRONMENT_NAME: '',
    EVIDENCE_NAMESPACE: 'emergency-incidents-staging', JWT_SECRET: 'synthetic-alert-native-secret-only',
    FRONTEND_URL: 'http://localhost:3000', BACKEND_URL: 'http://localhost:8000', COOKIE_DOMAIN: '',
    CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '', WEB_PUSH_PUBLIC_KEY: '', WEB_PUSH_PRIVATE_KEY: '',
    GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', GEMINI_API_KEY: '',
    SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '', SMTP_FROM: '', DOTENV_CONFIG_QUIET: 'true',
  });
  for (const test of ['tests/alert-database.integration.test.ts', 'tests/google-link-database.integration.test.ts']) {
    const status = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', test, '--maxWorkers=1'], { env, stdio: 'inherit', windowsHide: true });
      child.on('error', () => reject(new Error('TEST_RUNNER_UNAVAILABLE'))); child.on('close', accept);
    });
    if (status !== 0) throw new Error(test.includes('google-link') ? 'NATIVE_GOOGLE_LINK_TESTS_FAILED' : 'NATIVE_ALERT_TESTS_FAILED');
  }
  const leftovers = await client.query('SELECT (SELECT count(*) FROM "User") AS users, (SELECT count(*) FROM incidents) AS incidents, (SELECT count(*) FROM notification_outbox) AS jobs');
  if (Object.values(leftovers.rows[0]).some(value => Number(value) !== 0)) throw new Error('SYNTHETIC_FIXTURE_CLEANUP_FAILED');
  const authLeftovers = await client.query('SELECT (SELECT count(*) FROM "OAuthAccount") AS bindings, (SELECT count(*) FROM "GoogleLinkIntent") AS intents, (SELECT count(*) FROM "Token") AS tokens');
  if (Object.values(authLeftovers.rows[0]).some(value => Number(value) !== 0)) throw new Error('SYNTHETIC_AUTH_CLEANUP_FAILED');
  console.log(JSON.stringify({ passed: true, nativePostgreSQL: true, migrationSql: migrations.length, syntheticOnly: true, providerDelivery: false }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, reason: /^[A-Z_]{1,80}$/.test(error?.message || '') ? error.message : 'NATIVE_ALERT_GATE_FAILED' }));
  process.exitCode = 1;
} finally { if (client) await client.end().catch(() => {}); }
