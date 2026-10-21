import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectLocalContextMigrations, localMigrationDigest, LOCAL_CONTEXT_MIGRATION, type LocalMigrationRow } from '@/lib/local-report-context-migrations';

const intended = readFileSync(new URL('../prisma/migrations/20261020100000_report_request_context_retention/migration.sql', import.meta.url));
const old = Buffer.from('-- synthetic previous migration\n');
const sources = () => new Map([['synthetic_old', old], [LOCAL_CONTEXT_MIGRATION, intended]]);
const prior = (name = 'synthetic_old', bytes = old): LocalMigrationRow => ({ migration_name: name, checksum: localMigrationDigest(bytes), finished_at: new Date('2026-10-19T00:00:00Z'), rolled_back_at: null });

describe('local-only additive retention migration guard', () => {
  it('accepts only the exact new pending migration and never edits history', () => {
    const history = [prior()], before = JSON.stringify(history);
    expect(inspectLocalContextMigrations(history, sources())).toEqual({ pending: true, successful: 1 });
    expect(JSON.stringify(history)).toBe(before);
  });
  it('is idempotent after the exact intended SQL is applied', () => {
    expect(inspectLocalContextMigrations([prior(), prior(LOCAL_CONTEXT_MIGRATION, intended)], sources())).toEqual({ pending: false, successful: 2 });
  });
  it('accepts Windows CRLF source only if its original LF checksum still matches', () => {
    const current = sources(); current.set('synthetic_old', Buffer.from(old.toString().replaceAll('\n', '\r\n')));
    expect(inspectLocalContextMigrations([prior()], current).pending).toBe(true);
  });
  it('rejects missing intended source', () => {
    expect(() => inspectLocalContextMigrations([prior()], new Map([['synthetic_old', old]]))).toThrow('MIGRATION_SOURCE_CHANGED');
  });
  it('rejects edited intended SQL without silently updating its pin', () => {
    const current = sources(); current.set(LOCAL_CONTEXT_MIGRATION, Buffer.concat([intended, Buffer.from('-- changed')]));
    expect(() => inspectLocalContextMigrations([prior()], current)).toThrow('MIGRATION_SOURCE_CHANGED');
  });
  it('refuses any additional pending migration', () => {
    const current = sources(); current.set('synthetic_other_pending', old);
    expect(() => inspectLocalContextMigrations([prior()], current)).toThrow('OTHER_MIGRATIONS_PENDING');
  });
  it('refuses an edited historical checksum', () => {
    expect(() => inspectLocalContextMigrations([{ ...prior(), checksum: '0'.repeat(64) }], sources())).toThrow('HISTORICAL_CHECKSUM_CHANGED');
  });
  it('refuses unknown or duplicate successful historical migrations', () => {
    expect(() => inspectLocalContextMigrations([prior('unknown')], sources())).toThrow('HISTORY_SOURCE_MISMATCH');
    expect(() => inspectLocalContextMigrations([prior(), prior()], sources())).toThrow('HISTORY_SOURCE_MISMATCH');
  });
  it('refuses incomplete unrolled migration history instead of repairing it', () => {
    expect(() => inspectLocalContextMigrations([{ ...prior(), finished_at: null }], sources())).toThrow('HISTORY_REQUIRES_REVIEW');
  });
});
