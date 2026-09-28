// Check Node's native ESM resolution without contacting a database or provider.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://runtime:runtime@localhost:5432/runtime_check';

await Promise.all([
  import('../dist/app.js'),
  import('../dist/lib/jobs.js'),
]);
