// Check Node's native ESM resolution without contacting a database or provider.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://runtime:runtime@localhost:5432/runtime_check';
process.env.LOCAL_DEV_CONFIG_FILE = '';
process.env.REPORT_REQUEST_CONTEXT_ENABLED = 'false';
process.env.LOCAL_REPORT_CONTEXT_WORKER_ENABLED = 'false';

await Promise.all([
  import('../dist/app.js'),
  import('../dist/lib/jobs.js'),
  import('../dist/lib/socket-events.js'),
]);
