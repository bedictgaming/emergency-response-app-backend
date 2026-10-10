// Provider-free native PostgreSQL gate. Never accepts an application database.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
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
    if (migration === '20261009090000_google_account_linking') await snapshot('before-link-intent-migration');
    if (migration === '20261010090000_auth_identities') {
      const a = randomUUID(), b = randomUUID(), legacy = randomUUID(), subject = randomUUID();
      await client.query('INSERT INTO "User" (id,email,password,"updatedAt") VALUES ($1,$2,$3,now()),($4,$5,NULL,now())',
        [a, ' SYNTHETIC-Backfill@gmail.com ', 'synthetic-hash-not-a-credential', b, 'synthetic-google@gmail.com']);
      await client.query('INSERT INTO "OAuthAccount" (id,provider,"providerAccountId","userId") VALUES ($1,\'google\',$2,$3)', [legacy, subject, b]);
      const sql = await readFile(resolve('prisma/migrations', migration, 'migration.sql'), 'utf8');
      // Exercise the real migration's abort guards before the successful backfill.
      // Every attempted DDL has a freshly authenticated synthetic snapshot.
      for (const conflict of ['normalized-email', 'duplicate-provider', 'unknown-provider']) {
        const conflictingUser = randomUUID(), conflictingAccount = randomUUID();
        if (conflict === 'normalized-email') {
          await client.query('INSERT INTO "User" (id,email,"updatedAt") VALUES ($1,$2,now())', [conflictingUser, 'synthetic-backfill@gmail.com']);
        } else {
          await client.query('INSERT INTO "OAuthAccount" (id,provider,"providerAccountId","userId") VALUES ($1,$2,$3,$4)',
            [conflictingAccount, conflict === 'duplicate-provider' ? 'google' : 'synthetic-unsupported', randomUUID(), b]);
        }
        await snapshot(`before-identity-${conflict}-guard`);
        let rejected = false;
        try { await client.query(sql); }
        catch (error) {
          rejected = error.code === 'P0001' && error.message === (conflict === 'normalized-email'
            ? 'Identity migration requires review: conflicting normalized emails'
            : 'Identity migration requires review: legacy provider bindings');
        }
        finally { await client.query('ROLLBACK'); }
        const unchanged = (await client.query('SELECT to_regclass(\'public.auth_identities\') AS registry, (SELECT email FROM "User" WHERE id=$1) AS email', [a])).rows[0];
        if (!rejected || unchanged.registry !== null || unchanged.email !== ' SYNTHETIC-Backfill@gmail.com ') throw Error('IDENTITY_MIGRATION_ABORT_GUARD_FAILED');
        if (conflict === 'normalized-email') await client.query('DELETE FROM "User" WHERE id=$1', [conflictingUser]);
        else await client.query('DELETE FROM "OAuthAccount" WHERE id=$1', [conflictingAccount]);
      }
      await snapshot('before-identity-migration');
      await client.query(sql);
      const check = await client.query('SELECT (SELECT count(*) FROM auth_identities WHERE provider=\'password\' AND user_id=$1 AND provider_user_id=$1) AS password, (SELECT count(*) FROM auth_identities WHERE provider=\'google\' AND user_id=$2 AND provider_user_id=$3) AS google, (SELECT count(*) FROM "OAuthAccount" WHERE id=$4) AS legacy, (SELECT email FROM "User" WHERE id=$1) AS email', [a,b,subject,legacy]);
      const row = check.rows[0];
      if (Number(row.password)!==1 || Number(row.google)!==1 || Number(row.legacy)!==1 || row.email!=='synthetic-backfill@gmail.com') throw Error('IDENTITY_BACKFILL_FAILED');
      await client.query('DELETE FROM "User" WHERE id=ANY($1::text[])', [[a,b]]);
      continue;
    }
    await client.query(await readFile(resolve('prisma/migrations', migration, 'migration.sql'), 'utf8'));
  }
  key.fill(0);
  // Whitelist the child's environment. No inherited provider/application secrets.
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, {
    NODE_ENV: 'test', DATABASE_URL: supplied, DIRECT_URL: supplied, DISPOSABLE_DATABASE_URL: supplied,
    CONFIRM_DISPOSABLE_DATABASE: 'alert_disposable', RUN_ALERT_DATABASE_TESTS: '1', RUN_NATIVE_ALERT_RACES: '1', RUN_NATIVE_AUTH_IDENTITY_TESTS: '1',
    RUN_DATABASE_TESTS: '0', RUN_DISPOSABLE_DELIVERY_TESTS: '0', BACKGROUND_JOBS_ENABLED: 'false',
    EVIDENCE_DELETION_ENABLED: 'false', ORPHAN_EVIDENCE_SWEEP_ENABLED: 'false', API_GATEWAY_REQUIRED: 'false',
    API_GATEWAY_SECRET: '', API_GATEWAY_AUDIENCE: '', TRUSTED_PROXY_CIDRS: '', RAILWAY_ENVIRONMENT_NAME: '',
    EVIDENCE_NAMESPACE: 'emergency-incidents-staging', JWT_SECRET: 'synthetic-alert-native-secret-only',
    FRONTEND_URL: 'http://localhost:3000', BACKEND_URL: 'http://localhost:8000', COOKIE_DOMAIN: '',
    CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '', WEB_PUSH_PUBLIC_KEY: '', WEB_PUSH_PRIVATE_KEY: '',
    GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', GEMINI_API_KEY: '',
    SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '', SMTP_FROM: '', DOTENV_CONFIG_QUIET: 'true',
  });
  const status = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', 'tests/alert-database.integration.test.ts', 'tests/auth-identity-database.integration.test.ts', '--maxWorkers=1'], { env, stdio: 'inherit', windowsHide: true });
    child.on('error', () => reject(new Error('TEST_RUNNER_UNAVAILABLE'))); child.on('close', accept);
  });
  if (status !== 0) throw new Error('NATIVE_ALERT_TESTS_FAILED');
  const leftovers = await client.query('SELECT (SELECT count(*) FROM "User") AS users, (SELECT count(*) FROM incidents) AS incidents, (SELECT count(*) FROM notification_outbox) AS jobs');
  if (Object.values(leftovers.rows[0]).some(value => Number(value) !== 0)) throw new Error('SYNTHETIC_FIXTURE_CLEANUP_FAILED');
  console.log(JSON.stringify({ passed: true, nativePostgreSQL: true, migrationSql: migrations.length, syntheticOnly: true, providerDelivery: false }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, reason: /^[A-Z_]{1,80}$/.test(error?.message || '') ? error.message : 'NATIVE_ALERT_GATE_FAILED' }));
  process.exitCode = 1;
} finally { if (client) await client.end().catch(() => {}); }
