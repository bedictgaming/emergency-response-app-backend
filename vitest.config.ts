import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: { environment: 'node', globals: true, testTimeout: 15_000 },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
