// Reuse the already-approved isolated Windows runtime and dedicated demo
// credentials. Never accept a supplied database URL or contact hosted storage.
import dotenv from 'dotenv';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import pg from 'pg';
import { configureLocalDevelopment } from '@/lib/local-development-config';
import { captureLogicalBackup } from '@/lib/logical-backup';
import { loadBackupKey, encryptBackup, decryptBackup } from '@/lib/backup-crypto';

const migration = '20261019130000_nearby_department_intake';
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const must: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw Error(code); };
let client: pg.Client | undefined;
try {
  dotenv.config({ quiet: true });
  const action = process.argv[2];
  must(['prepare', 'serve'].includes(action ?? ''), 'LOCAL_ACTION_REQUIRED');
  const root = path.join(process.env.USERPROFILE || '', '.emergency-response-local', 'development');
  must(process.platform === 'win32' && process.env.NODE_ENV === 'development'
    && process.env.LOCAL_DEV_CONFIG_FILE === path.join(root, 'backend-private.json').replaceAll('\\', '/'), 'APPROVED_LOCAL_MODE_REQUIRED');
  configureLocalDevelopment();
  const url = new URL(process.env.DATABASE_URL || '');
  must(url.hostname === '127.0.0.1' && url.port === '55432' && url.pathname === '/emergency_response_dev', 'LOCAL_TARGET_REQUIRED');
  client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  must((await client.query('SELECT current_database() AS name')).rows[0].name === 'emergency_response_dev', 'LOCAL_DATABASE_IDENTITY_CHANGED');
  const history = (await client.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations')).rows;
  const folders = (await readdir(path.resolve('prisma/migrations'), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name);
  const pending: string[] = [];
  for (const name of folders) {
    const prior = history.find(item => item.migration_name === name && item.finished_at && !item.rolled_back_at);
    if (prior) {
      const bytes = await readFile(path.resolve('prisma/migrations', name, 'migration.sql'));
      // Windows checkout CRLF is the only accepted alternate encoding. The
      // original LF checksum must still match; never rewrite old history/pins.
      must(prior.checksum === digest(bytes) || prior.checksum === digest(bytes.toString('utf8').replaceAll('\r\n', '\n')), 'LOCAL_MIGRATION_SOURCE_CHANGED');
    }
    else pending.push(name);
  }
  must(!history.some(item => !item.finished_at && !item.rolled_back_at), 'LOCAL_MIGRATION_REQUIRES_REVIEW');
  must(pending.length === 0 || pending.length === 1 && pending[0] === migration, 'OTHER_LOCAL_MIGRATIONS_PENDING');
  if (action === 'prepare' && pending.length) {
    delete process.env.BACKUP_ENCRYPTION_KEY;
    process.env.BACKUP_ENCRYPTION_KEY_FILE = path.join(root, 'development-backup.key');
    const key = await loadBackupKey();
    const snapshot = await captureLogicalBackup(client, { host: '127.0.0.1', database: 'emergency_response_dev' });
    const plaintext = Buffer.from(JSON.stringify(snapshot));
    const directory = path.join(root, 'backups'); await mkdir(directory, { recursive: true });
    const output = path.join(directory, `nearby-intake-before-${Date.now()}.json.enc`);
    const encrypted = encryptBackup(plaintext, key); await writeFile(output, encrypted, { flag: 'wx', mode: 0o600 });
    const recovered = decryptBackup(await readFile(output), key);
    must(recovered.equals(plaintext), 'LOCAL_ENCRYPTED_BACKUP_AUTHENTICATION_FAILED');
    recovered.fill(0); plaintext.fill(0); key.fill(0);
    console.log(JSON.stringify({ localOnly: true, encryptedBackupAuthenticated: true, backup: output }));
    const applied = spawnSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      env: { ...process.env, NEARBY_REVIEW_ENABLED: 'false' }, windowsHide: true, stdio: 'pipe', timeout: 90000,
    });
    must(applied.status === 0, 'LOCAL_MIGRATION_NOT_CONFIRMED');
  } else must(pending.length === 0, 'RUN_LOCAL_PREPARATION_FIRST');
  must((await client.query('SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL', [migration])).rows[0].count === 1,
    'LOCAL_INTAKE_MIGRATION_NOT_CONFIRMED');
  await client.end(); client = undefined;
  console.log(JSON.stringify({ localOnly: true, prepared: true, hostedDatabaseChanged: false, liveDeploymentChanged: false }));
  if (action === 'serve') {
    const child = spawn(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'watch', 'src/server.ts'], {
      env: { ...process.env, NEARBY_REVIEW_ENABLED: 'true' }, stdio: 'inherit', windowsHide: true,
    });
    const code = await new Promise<number>(resolve => { child.on('error', () => resolve(1)); child.on('close', value => resolve(value ?? 1)); });
    process.exitCode = code;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(JSON.stringify({ prepared: false, reason: /^[A-Z_]{1,80}$/.test(message) ? message : 'LOCAL_NEARBY_PREPARATION_FAILED', liveDeploymentChanged: false }));
  process.exitCode = 1;
} finally { if (client) await client.end().catch(() => {}); }
