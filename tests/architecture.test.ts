import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(item => {
    const path = resolve(folder, item.name);
    return item.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}
function imports(file: string) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return { text, source, imports: source.statements.filter(ts.isImportDeclaration) };
}
describe('architecture boundaries', () => {
  it('keeps one canonical middleware, validation, and policy tree', () => {
    for (const folder of ['domain', 'middleware', 'validation', 'routes', 'controllers', 'services', 'repositories'])
      expect(existsSync(resolve(root, 'src', folder)), folder).toBe(true);
    for (const folder of ['schema', 'middlewares']) expect(existsSync(resolve(root, 'src', folder)), folder).toBe(false);
  });
  it('policy modules have no HTTP, database-client, provider, or environment dependencies', () => {
    for (const file of sources(resolve(root, 'src/domain'))) {
      const { text, imports: declarations } = imports(file);
      for (const declaration of declarations) {
        const specifier = (declaration.moduleSpecifier as ts.StringLiteral).text;
        const typeOnly = declaration.importClause?.isTypeOnly;
        expect(typeOnly || specifier.startsWith('@/domain/') || specifier === '@/generated/prisma' || specifier === 'zod', relative(root, file)).toBe(true);
      }
      expect(text, relative(root, file)).not.toMatch(/process\.env|\bfetch\s*\(|\$transaction|\$queryRaw|\$executeRaw/);
    }
  });
  it('controllers adapt HTTP, but never query Prisma or call repositories directly', () => {
    for (const file of sources(resolve(root, 'src/controllers'))) {
      const { text } = imports(file);
      expect(text, relative(root, file)).not.toMatch(/@\/lib\/prisma|@\/repositories\/|\$transaction|\$queryRaw|\$executeRaw/);
    }
  });
  it('validation does not depend on controllers, repositories, services, or HTTP', () => {
    for (const file of sources(resolve(root, 'src/validation'))) {
      expect(readFileSync(file, 'utf8'), relative(root, file)).not.toMatch(/@\/(?:controllers|repositories|services|middleware)\/|from\s+['"]express['"]/);
    }
  });
  it('retired entry points and schema history survive dead-code cleanup', () => {
    expect(readFileSync(resolve(root, 'src/routes/responder.routes.ts'), 'utf8')).toContain('res.status(410)');
    const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
    for (const model of ['model Responder', 'model AuthIdentity', 'model IncidentReviewFlag']) expect(schema).toContain(model);
    expect(existsSync(resolve(root, 'prisma/migrations/20261013150000_false_report_cancellation/migration.sql'))).toBe(true);
  });
});
