import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveRuntimeImports, rewriteRuntimeImports } from './resolve-runtime-imports.mjs';

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'runtime-imports-test-'));
  const root = path.join(temporary, 'dist');
  await mkdir(path.join(root, 'lib'), { recursive: true });
  await mkdir(path.join(root, 'routes'), { recursive: true });
  await writeFile(path.join(root, 'lib', 'value.js'), 'export const value = 1;');
  await writeFile(path.join(root, 'routes', 'index.js'), 'export default {};');
  t.after(async () => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('runtime-imports-test-'));
    await rm(temporary, { recursive: true });
  });
  return { root, file: path.join(root, 'app.js') };
}

test('resolves aliases, side effects, re-exports, dynamic import and require with native ESM paths', async t => {
  const { root, file } = await fixture(t);
  const source = "import {value} from '@/lib/value';\nimport '@/routes';\nexport {value} from '@/lib/value';\nconst a=import('@/routes');const b=require('@/lib/value');";
  const result = await rewriteRuntimeImports(source, file, root);
  assert.equal((result.match(/\.\/lib\/value\.js/g) ?? []).length, 3);
  assert.equal((result.match(/\.\/routes\/index\.js/g) ?? []).length, 2);
  assert.ok(!result.includes('@/'));
});

test('resolves relative extensions and directory indexes from nested modules', async t => {
  const { root } = await fixture(t);
  const result = await rewriteRuntimeImports("import '../lib/value'; export * from '../routes';", path.join(root, 'lib', 'consumer.js'), root);
  assert.equal(result, 'import "./value.js"; export * from "../routes/index.js";');
});

test('preserves valid ESM query/fragment suffixes including copied Prisma edge loaders', async t => {
  const { root, file } = await fixture(t);
  await writeFile(path.join(root, 'engine.wasm'), 'synthetic wasm placeholder');
  assert.equal(await rewriteRuntimeImports("export default import('./engine.wasm?module');", file, root), "export default import('./engine.wasm?module');");
  assert.equal(await rewriteRuntimeImports("import('@/lib/value?cache#version');", file, root), 'import("./lib/value.js?cache#version");');
});

test('preserves unrelated literals, comments, package imports and already resolved specifiers', async t => {
  const { root, file } = await fixture(t);
  const source = "// import '@/not-code'\nconst label='@/not-code';const path='../not-a-module';import 'express';import '@prisma/client';import './lib/value.js';";
  assert.equal(await rewriteRuntimeImports(source, file, root), source);
});

test('rejects missing or escaping imports and files outside the output root', async t => {
  const { root, file } = await fixture(t);
  await assert.rejects(rewriteRuntimeImports("import '@/missing';", file, root), /BUILD_IMPORT_TARGET_MISSING/);
  await assert.rejects(rewriteRuntimeImports("import '../../outside.js';", file, root), /BUILD_IMPORT_OUTSIDE_DIST/);
  await assert.rejects(rewriteRuntimeImports("import '@/../outside.js';", file, root), /BUILD_IMPORT_OUTSIDE_DIST/);
  await assert.rejects(rewriteRuntimeImports('', path.join(root, '..', 'outside.js'), root), /BUILD_FILE_OUTSIDE_DIST/);
});

test('validates the whole tree before writing and remains idempotent', async t => {
  const { root, file } = await fixture(t);
  const before = "import '@/lib/value';";
  await writeFile(file, before);
  await writeFile(path.join(root, 'broken.js'), "import '@/not-present';");
  await assert.rejects(resolveRuntimeImports(root), /BUILD_IMPORT_TARGET_MISSING/);
  assert.equal(await readFile(file, 'utf8'), before);
  await writeFile(path.join(root, 'broken.js'), 'export {};');
  assert.equal(await resolveRuntimeImports(root), 1);
  assert.equal(await resolveRuntimeImports(root), 0);
});

test('only permits the dedicated dist output directory', async t => {
  const { root } = await fixture(t);
  await assert.rejects(resolveRuntimeImports(path.dirname(root)), /BUILD_DIST_REQUIRED/);
});
