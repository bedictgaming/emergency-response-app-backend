// Approved Windows localhost activation only. No supplied URL, cloud command,
// production credentials, legacy redaction, key creation or provider operation.
import dotenv from 'dotenv';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { configureLocalDevelopment } from '@/lib/local-development-config';
import { captureLogicalBackup, requireRestorableBackup } from '@/lib/logical-backup';
import { loadBackupKey, encryptBackup, decryptBackup } from '@/lib/backup-crypto';
import { inspectLocalContextMigrations, localMigrationDigest, LOCAL_CONTEXT_MIGRATION, type LocalMigrationRow } from '@/lib/local-report-context-migrations';

const must: (value: unknown, reason: string) => asserts value = (value, reason) => { if (!value) throw Error(reason); };
let client: pg.Client | undefined;
let key: Buffer | undefined, plaintext: Buffer | undefined, recovered: Buffer | undefined;
let stage = 'configuration';
try {
  dotenv.config({ quiet: true });
  const action = process.argv[2];
  must(['inspect', 'prepare', 'verify'].includes(action || ''), 'LOCAL_RETENTION_ACTION_REQUIRED');
  const root = path.join(process.env.USERPROFILE || '', '.emergency-response-local', 'development');
  must(process.platform === 'win32' && process.env.NODE_ENV === 'development'
    && process.env.LOCAL_DEV_CONFIG_FILE === path.join(root, 'backend-private.json').replaceAll('\\', '/'), 'LOCAL_RETENTION_APPROVED_MODE_REQUIRED');
  configureLocalDevelopment();
  const target = new URL(process.env.DATABASE_URL || '');
  must(process.env.LOCAL_DEV_ACTIVE === 'true' && target.hostname === '127.0.0.1' && target.port === '55432'
    && target.pathname === '/emergency_response_dev' && target.username === 'er_local_app'
    && !target.search && !target.hash && process.env.BACKGROUND_JOBS_ENABLED === 'false'
    && process.env.EVIDENCE_DELETION_ENABLED === 'false' && process.env.ORPHAN_EVIDENCE_SWEEP_ENABLED === 'false', 'LOCAL_RETENTION_TARGET_REQUIRED');
  client = new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis: 5000 });
  await client.connect(); stage = 'identity';
  const identity = (await client.query(`SELECT current_database()='emergency_response_dev' AS database_matches,
    current_user='er_local_app' AS role_matches, host(inet_server_addr())='127.0.0.1' AS address_matches,
    inet_server_port()=55432 AS port_matches, extract(epoch FROM statement_timestamp())*1000 AS clock_ms,
    current_setting('TimeZone') AS timezone`)).rows[0];
  must(identity.database_matches && identity.role_matches && identity.address_matches && identity.port_matches
    && Math.abs(Number(identity.clock_ms) - Date.now()) < 5000, 'LOCAL_RETENTION_DATABASE_IDENTITY_OR_CLOCK_CHANGED');
  const sources = new Map<string, Buffer>();
  for (const item of (await readdir(path.resolve('prisma/migrations'), { withFileTypes: true })).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    sources.set(item.name, await readFile(path.resolve('prisma/migrations', item.name, 'migration.sql')));
  }
  stage = 'history';
  const history = (await client.query<LocalMigrationRow>('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name')).rows;
  const state = inspectLocalContextMigrations(history, sources);
  const catalogSql = `SELECT c.relname AS name, a.attname AS column, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> 'report_request_contexts'
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`;
  const beforeCatalog = localMigrationDigest(JSON.stringify((await client.query(catalogSql)).rows));
  let backupFile: string | undefined;
  if (action === 'prepare' && state.pending) {
    stage = 'backup';
    delete process.env.BACKUP_ENCRYPTION_KEY;
    process.env.BACKUP_ENCRYPTION_KEY_FILE = path.join(root, 'development-backup.key');
    try { key = await loadBackupKey(); } catch { throw Error('LOCAL_RETENTION_BACKUP_KEY_UNAVAILABLE'); }
    const snapshot = await captureLogicalBackup(client, { host: '127.0.0.1', database: 'emergency_response_dev' });
    plaintext = Buffer.from(JSON.stringify(snapshot));
    const directory = path.join(root, 'backups'); await mkdir(directory, { recursive: true });
    backupFile = path.join(directory, `report-context-before-${Date.now()}.json.enc`);
    await writeFile(backupFile, encryptBackup(plaintext, key), { flag: 'wx', mode: 0o600 });
    recovered = decryptBackup(await readFile(backupFile), key);
    must(recovered.equals(plaintext), 'LOCAL_RETENTION_ENCRYPTED_BACKUP_AUTHENTICATION_FAILED');
    requireRestorableBackup(JSON.parse(recovered.toString('utf8')));
    recovered.fill(0); plaintext.fill(0); key.fill(0);
    console.log(JSON.stringify({ localOnly: true, encryptedBackupAuthenticated: true, backup: backupFile, restoreDrill: false }));
    // Recheck every source/history before handing only the reviewed pending SQL
    // to Prisma's ordinary operator migration path. Never reset/repair history.
    for (const [name, bytes] of sources) must((await readFile(path.resolve('prisma/migrations', name, 'migration.sql'))).equals(bytes), 'LOCAL_RETENTION_SOURCE_CHANGED_AFTER_BACKUP');
    must((await readdir(path.resolve('prisma/migrations'), { withFileTypes: true })).filter(item => item.isDirectory()).length === sources.size, 'LOCAL_RETENTION_SOURCE_SET_CHANGED');
    must(inspectLocalContextMigrations((await client.query<LocalMigrationRow>('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations')).rows, sources).pending,
      'LOCAL_RETENTION_HISTORY_CHANGED_AFTER_BACKUP');
    stage = 'migration';
    const applied = spawnSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      env: { ...process.env, REPORT_REQUEST_CONTEXT_ENABLED: 'false', LOCAL_REPORT_CONTEXT_WORKER_ENABLED: 'false' },
      windowsHide: true, stdio: 'pipe', timeout: 90000,
    });
    must(applied.status === 0, 'LOCAL_RETENTION_MIGRATION_NOT_CONFIRMED');
  }
  if (action !== 'inspect') {
    stage = 'postcheck';
    const after = (await client.query<LocalMigrationRow>('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name')).rows;
    must(!inspectLocalContextMigrations(after, sources).pending, 'LOCAL_RETENTION_PREPARATION_REQUIRED');
    const oldAfter = after.filter(row => row.migration_name !== LOCAL_CONTEXT_MIGRATION);
    must(JSON.stringify(oldAfter) === JSON.stringify(history.filter(row => row.migration_name !== LOCAL_CONTEXT_MIGRATION)), 'LOCAL_RETENTION_HISTORICAL_ROWS_CHANGED');
    must(localMigrationDigest(JSON.stringify((await client.query(catalogSql)).rows)) === beforeCatalog, 'LOCAL_RETENTION_EXISTING_CATALOG_CHANGED');
    const fields = (await client.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='report_request_contexts' ORDER BY ordinal_position")).rows;
    must(JSON.stringify(fields.map(row => [row.column_name, row.data_type])) === JSON.stringify([
      ['audit_log_id','uuid'], ['captured_at','timestamp with time zone'], ['expires_at','timestamp with time zone'], ['ip_address','character varying'], ['user_agent','character varying'],
    ]), 'LOCAL_RETENTION_TABLE_SHAPE_CHANGED');
    if (action === 'verify') {
      stage = 'worker';
      const { ENV } = await import('@/config/env');
      must(ENV.REPORT_REQUEST_CONTEXT_ENABLED && ENV.LOCAL_REPORT_CONTEXT_WORKER_ENABLED && !ENV.BACKGROUND_JOBS_ENABLED
        && !ENV.EVIDENCE_DELETION_ENABLED && !ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED, 'LOCAL_RETENTION_NOT_ENABLED');
      const { processExpiredReportContexts } = await import('@/lib/report-context-retention');
      const { prisma } = await import('@/lib/prisma');
      try {
        // First activation must not contain old context: no legacy migration or
        // destructive preview is hidden in this verification command.
        must((await client.query('SELECT count(*)::int AS count FROM report_request_contexts')).rows[0].count === 0, 'LOCAL_RETENTION_EXISTING_CONTEXT_REQUIRES_REVIEW');
        const result = await processExpiredReportContexts();
        must(result.status === 'applied' && result.deleted === 0, 'LOCAL_RETENTION_EMPTY_WORKER_NOT_CONFIRMED');
      } finally { await prisma.$disconnect(); }
    }
  }
  const receipt = { at: new Date().toISOString(), localOnly: true, action, prepared: action !== 'inspect', pendingMigration: action === 'inspect' && state.pending,
    workerVerified: action === 'verify', backgroundJobsEnabled: false, evidenceDeletionEnabled: false,
    databaseTimeZone: identity.timezone, instantBasedCapture: true, backup: backupFile,
    productionChanged: false, legacyDataChanged: false };
  if (action !== 'inspect') {
    const directory = path.join(root, 'privacy-retention-receipts'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${action}-${Date.now()}.json`), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(receipt));
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(JSON.stringify({ passed: false, stage, reason: /^[A-Z_]{1,90}$/.test(message) ? message : 'LOCAL_RETENTION_OPERATION_FAILED', productionChanged: false }));
  process.exitCode = 1;
} finally {
  key?.fill(0); plaintext?.fill(0); recovered?.fill(0);
  if (client) await client.end().catch(() => {});
}
