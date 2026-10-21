// Local-only additive preparation. No hosted credentials, key creation, pin
// changes, history resets or ordinary report mutations are supported here.
import dotenv from 'dotenv';
import { readFile, readdir, mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { configureLocalDevelopment } from '@/lib/local-development-config';
import { captureLogicalBackup } from '@/lib/logical-backup';
import { loadBackupKey, encryptBackup, decryptBackup } from '@/lib/backup-crypto';
const migration = '20261020170000_nearby_response_starts';
const must: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw Error(code); };
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const canonicalRows = (rows: object[]) => JSON.stringify(rows.map(row => JSON.stringify(row)).sort());
let client: pg.Client | undefined;
try {
  dotenv.config({ quiet: true });
  must(process.argv[2] === 'prepare', 'LOCAL_PREPARE_ACTION_REQUIRED');
  const root = path.join(process.env.USERPROFILE || '', '.emergency-response-local', 'development');
  must(process.platform === 'win32' && process.env.NODE_ENV === 'development'
    && process.env.LOCAL_DEV_CONFIG_FILE === path.join(root, 'backend-private.json').replaceAll('\\', '/')
    && !process.env.DATABASE_URL && !process.env.DIRECT_URL, 'APPROVED_LOCAL_MODE_REQUIRED');
  // Stop the task-owned application before backup/backfill, so an old-mode
  // acknowledgment cannot commit between the snapshot, backfill and activation.
  const listening = await new Promise<boolean>(resolve => {
    const socket = connect({ host: '127.0.0.1', port: 8000 });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
  must(!listening, 'STOP_LOCAL_BACKEND_BEFORE_PREPARATION');
  configureLocalDevelopment();
  const url = new URL(process.env.DATABASE_URL || '');
  must(url.hostname === '127.0.0.1' && url.port === '55432' && url.pathname === '/emergency_response_dev' && url.username === 'er_local_app', 'LOCAL_TARGET_REQUIRED');
  client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 }); await client.connect();
  must((await client.query('SELECT current_database() AS name')).rows[0].name === 'emergency_response_dev', 'LOCAL_DATABASE_IDENTITY_CHANGED');
  const history = (await client.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations')).rows;
  const folders = (await readdir(path.resolve('prisma/migrations'), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name);
  must(history.every(row => row.finished_at && !row.rolled_back_at && folders.includes(row.migration_name))
    && new Set(history.map(row => row.migration_name)).size === history.length, 'LOCAL_MIGRATION_HISTORY_REQUIRES_REVIEW');
  const pending: string[] = [];
  for (const name of folders) {
    const prior = history.find(row => row.migration_name === name);
    if (!prior) { pending.push(name); continue; }
    const bytes = await readFile(path.resolve('prisma/migrations', name, 'migration.sql'));
    must(prior.checksum === digest(bytes) || prior.checksum === digest(bytes.toString('utf8').replaceAll('\r\n', '\n')), 'LOCAL_MIGRATION_SOURCE_CHANGED');
  }
  must(pending.length === 1 && pending[0] === migration && history.some(row => row.migration_name === '20261019130000_nearby_department_intake'), 'ONLY_NEW_LOCAL_RESPONSE_START_MIGRATION_ALLOWED');
  const before = await captureLogicalBackup(client, { host: '127.0.0.1', database: 'emergency_response_dev' });
  must(!before.tables.incident_nearby_response_starts, 'LOCAL_RESPONSE_START_TABLE_ALREADY_PRESENT');
  delete process.env.BACKUP_ENCRYPTION_KEY;
  process.env.BACKUP_ENCRYPTION_KEY_FILE = path.join(root, 'development-backup.key');
  const key = await loadBackupKey(), plaintext = Buffer.from(JSON.stringify(before));
  const directory = path.join(root, 'backups'); await mkdir(directory, { recursive: true });
  const output = path.join(directory, `response-start-before-${Date.now()}.json.enc`);
  try {
    const file = await open(output, 'wx', 0o600);
    try { await file.writeFile(encryptBackup(plaintext, key)); await file.sync(); } finally { await file.close(); }
    const recovered = decryptBackup(await readFile(output), key);
    try { must(recovered.equals(plaintext), 'LOCAL_ENCRYPTED_BACKUP_AUTHENTICATION_FAILED'); } finally { recovered.fill(0); }
  } finally { key.fill(0); plaintext.fill(0); }
  console.log(JSON.stringify({ localOnly: true, encryptedBackupAuthenticated: true, backup: output }));
  const applied = spawnSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
    env: { ...process.env, NEARBY_RESPONSE_START_ENABLED: 'false' }, windowsHide: true, stdio: 'pipe', timeout: 90000,
  });
  must(applied.status === 0, 'LOCAL_MIGRATION_NOT_CONFIRMED');
  const after = await captureLogicalBackup(client, { host: '127.0.0.1', database: 'emergency_response_dev' });
  for (const [table, rows] of Object.entries(before.tables)) {
    must(JSON.stringify(before.columns[table]) === JSON.stringify(after.columns[table]), 'LOCAL_EXISTING_COLUMNS_CHANGED');
    if (table === '_prisma_migrations') {
      must(after.tables[table].length === rows.length + 1 && canonicalRows(rows) === canonicalRows(after.tables[table].filter(row => row.migration_name !== migration)), 'LOCAL_EXISTING_MIGRATION_HISTORY_CHANGED');
    } else must(canonicalRows(rows) === canonicalRows(after.tables[table]), 'LOCAL_EXISTING_DATA_CHANGED');
  }
  const legacy = before.tables.incident_nearby_reviews.filter(row => row.status === 'ACKNOWLEDGED');
  must(after.tables.incident_nearby_response_starts.length === legacy.length, 'LOCAL_LEGACY_START_COUNT_CHANGED');
  for (const review of legacy) {
    const receipt = after.tables.incident_nearby_response_starts.find(row => row.review_id === review.review_id);
    must(receipt && receipt.legacy_admission === 'true' && receipt.expected_review_version === review.version
      && receipt.started_by === review.reviewed_by && receipt.started_at === (review.reviewed_at ?? review.created_at), 'LOCAL_LEGACY_ADMISSION_NOT_PRESERVED');
  }
  must(after.tables._prisma_migrations.some(row => row.migration_name === migration && row.finished_at && !row.rolled_back_at), 'LOCAL_NEW_MIGRATION_NOT_RECORDED');
  console.log(JSON.stringify({ localOnly: true, prepared: true, previousTablesUnchanged: true, legacyAdmissionsPreserved: legacy.length,
    liveDeploymentChanged: false, flagActivated: false }));
} catch (error) {
  const reason = error instanceof Error ? error.message : '';
  console.error(JSON.stringify({ prepared: false, reason: /^[A-Z_]{1,80}$/.test(reason) ? reason : 'LOCAL_RESPONSE_START_PREPARATION_FAILED', liveDeploymentChanged: false }));
  process.exitCode = 1;
} finally { if (client) await client.end().catch(() => {}); }
