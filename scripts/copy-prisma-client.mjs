import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Prisma's custom generator emits JavaScript, which TypeScript does not copy
// into dist. Keep its runtime, schema, and platform engine beside the compiled
// application before resolving aliases to native ESM import paths.
await cp(
  path.join(root, 'src', 'generated', 'prisma'),
  path.join(root, 'dist', 'generated', 'prisma'),
  { recursive: true, force: true },
);
