// Replace the glob-based tsc-alias build step with TypeScript AST-owned edits.
// Only emitted local module specifiers change; no regex edits to program strings.
import ts from 'typescript';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const within = (root, file) => file.startsWith(root + path.sep);
async function moduleTarget(specifier, file, root) {
  const requested = specifier.startsWith('@/') ? path.resolve(root, specifier.slice(2)) : path.resolve(path.dirname(file), specifier);
  if (!within(root, requested)) throw Error('BUILD_IMPORT_OUTSIDE_DIST');
  for (const candidate of [requested, requested + '.js', path.join(requested, 'index.js')]) {
    const stat = await lstat(candidate).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
    if (!stat?.isFile()) continue;
    if (stat.isSymbolicLink() || !within(root, await realpath(candidate))) throw Error('BUILD_IMPORT_LINK_REFUSED');
    return candidate;
  }
  throw Error('BUILD_IMPORT_TARGET_MISSING');
}

export async function rewriteRuntimeImports(source, file, root) {
  root = path.resolve(root); file = path.resolve(file);
  if (!within(root, file)) throw Error('BUILD_FILE_OUTSIDE_DIST');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw Error('BUILD_JAVASCRIPT_PARSE_FAILED');
  const literals = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      literals.push(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      literals.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const edits = [];
  for (const literal of literals) {
    const value = literal.text;
    if (!value.startsWith('@/') && !value.startsWith('./') && !value.startsWith('../')) continue;
    // Native ESM specifiers may carry a query/fragment. Prisma's copied edge
    // loader uses .wasm?module; resolve the file, preserving its URL suffix.
    const boundary = value.search(/[?#]/);
    const pathname = boundary === -1 ? value : value.slice(0, boundary);
    const suffix = boundary === -1 ? '' : value.slice(boundary);
    const target = await moduleTarget(pathname, file, root);
    let relative = path.relative(path.dirname(file), target).split(path.sep).join('/');
    if (!relative.startsWith('.')) relative = './' + relative;
    relative += suffix;
    if (value !== relative) edits.push({ start: literal.getStart(tree), end: literal.end, value: JSON.stringify(relative) });
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}

export async function resolveRuntimeImports(directory) {
  const root = path.resolve(directory);
  if (path.basename(root) !== 'dist' || (await lstat(root)).isSymbolicLink() || path.resolve(await realpath(root)) !== root) throw Error('BUILD_DIST_REQUIRED');
  const plans = [];
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw Error('BUILD_TREE_LINK_REFUSED');
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
        const before = await readFile(file, 'utf8');
        const after = await rewriteRuntimeImports(before, file, root);
        if (after !== before) plans.push({ file, after });
      }
    }
  }
  // Validate the entire output before modifying any emitted file.
  await walk(root);
  for (const plan of plans) await writeFile(plan.file, plan.after);
  return plans.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const changed = await resolveRuntimeImports(fileURLToPath(new URL('../dist', import.meta.url)));
    console.log(JSON.stringify({ runtimeImportsResolved: true, changedFiles: changed }));
  } catch (error) {
    const safe = ['BUILD_IMPORT_OUTSIDE_DIST', 'BUILD_IMPORT_LINK_REFUSED', 'BUILD_IMPORT_TARGET_MISSING', 'BUILD_FILE_OUTSIDE_DIST',
      'BUILD_JAVASCRIPT_PARSE_FAILED', 'BUILD_DIST_REQUIRED', 'BUILD_TREE_LINK_REFUSED'];
    console.error(safe.includes(error?.message) ? error.message : 'BUILD_IMPORT_RESOLUTION_FAILED'); process.exitCode = 1;
  }
}
