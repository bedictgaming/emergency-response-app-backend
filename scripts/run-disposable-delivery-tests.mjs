import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supplied = process.env.DISPOSABLE_DATABASE_URL;
const confirmation = process.env.CONFIRM_DISPOSABLE_DATABASE;

function databaseName(value) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return null;
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
}

const target = supplied && databaseName(supplied);
const configured = [process.env.DATABASE_URL, process.env.DIRECT_URL]
  .filter(Boolean)
  .map(databaseName);

if (!target || !/(?:test|staging|disposable)/i.test(target)
  || confirmation !== target || configured.includes(target)) {
  console.error(
    'Refusing write tests. Provide DISPOSABLE_DATABASE_URL for an isolated, already-migrated test database, '
    + 'and set CONFIRM_DISPOSABLE_DATABASE to that exact database name. '
    + 'Its name must include test, staging, or disposable and must differ from the configured application database.',
  );
  process.exit(2);
}

const child = spawnSync(
  process.execPath,
  [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/disposable-delivery.integration.test.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: supplied,
      DIRECT_URL: supplied,
      NODE_ENV: 'test',
      RUN_DISPOSABLE_DELIVERY_TESTS: '1',
    },
  },
);

process.exit(child.status ?? 1);
