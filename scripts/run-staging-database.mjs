import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2];
const name = process.argv[3];
const actions = new Set(['status', 'backup', 'migrate', 'test-db', 'test-delivery']);

if (!actions.has(action) || !/^emergency_staging_\d{8}_[a-f0-9]{6}$/.test(name || '')) {
  console.error('Usage: node scripts/run-staging-database.mjs <status|backup|migrate|test-db|test-delivery> <emergency_staging_YYYYMMDD_hex> [--confirm-offline-key]');
  process.exit(2);
}

const applicationUrl = new URL(process.env.DATABASE_URL || '');
const directUrl = new URL(process.env.DIRECT_URL || '');
if (applicationUrl.pathname !== directUrl.pathname || decodeURIComponent(directUrl.pathname.slice(1)) === name) {
  throw new Error('The configured application and direct databases must match and differ from staging.');
}

const targetUrl = new URL(directUrl);
targetUrl.pathname = `/${name}`;
if (['prefer', 'require', 'verify-ca'].includes(targetUrl.searchParams.get('sslmode'))) {
  targetUrl.searchParams.set('sslmode', 'verify-full');
}
const probe = new pg.Client({ connectionString: targetUrl.toString() });
await probe.connect();
try {
  const result = await probe.query('SELECT current_database() AS name');
  if (result.rows[0]?.name !== name) throw new Error('Staging connection resolved to the wrong database.');
} finally {
  await probe.end();
}

function run(script, args, overrides = {}) {
  const child = spawnSync(process.execPath, [resolve(root, script), ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...overrides },
  });
  if (child.status !== 0) process.exit(child.status ?? 1);
}

const stagingEnv = { DATABASE_URL: targetUrl.toString(), DIRECT_URL: targetUrl.toString() };
const backupDirectory = resolve(root, '..', '.database-backups', 'staging', name);

switch (action) {
  case 'status':
    run('node_modules/prisma/build/index.js', ['migrate', 'status'], stagingEnv);
    break;
  case 'backup':
    await mkdir(backupDirectory, { recursive: true });
    run('node_modules/tsx/dist/cli.mjs', ['src/backup-database.ts', backupDirectory], stagingEnv);
    break;
  case 'migrate':
    if (process.argv[4] !== '--confirm-offline-key') {
      throw new Error('Migration paused: confirm the encryption key has a separate offline copy.');
    }
    await mkdir(backupDirectory, { recursive: true });
    run('node_modules/tsx/dist/cli.mjs', ['src/backup-database.ts', backupDirectory], stagingEnv);
    run('node_modules/prisma/build/index.js', ['migrate', 'deploy'], stagingEnv);
    break;
  case 'test-db':
    run('node_modules/vitest/vitest.mjs', ['run', 'tests/database.integration.test.ts'], {
      ...stagingEnv,
      RUN_DATABASE_TESTS: '1',
    });
    break;
  case 'test-delivery':
    run('scripts/run-disposable-delivery-tests.mjs', [], {
      DISPOSABLE_DATABASE_URL: targetUrl.toString(),
      CONFIRM_DISPOSABLE_DATABASE: name,
    });
    break;
}
