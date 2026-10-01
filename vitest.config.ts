import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Standalone operator diagnostics use node:test and are not Vitest suites.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', globals: true, testTimeout: 15_000 },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
