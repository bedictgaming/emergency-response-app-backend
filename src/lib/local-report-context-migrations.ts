import { createHash } from 'node:crypto';

export const LOCAL_CONTEXT_MIGRATION = '20261020100000_report_request_context_retention';
export const LOCAL_CONTEXT_MIGRATION_SHA256 = 'e18c80d183b75e32def2b930cfb879d5c7f7f79a9e2b8d4eeb5624dcdfb874c0';
export type LocalMigrationRow = { migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null };
export const localMigrationDigest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** No history repair or checksum updates. Only this exact additive migration
 * may be pending; fail closed on any extra, edited, missing or failed source.
 */
export function inspectLocalContextMigrations(history: LocalMigrationRow[], sources: Map<string, Buffer>) {
  const intended = sources.get(LOCAL_CONTEXT_MIGRATION);
  if (!intended || localMigrationDigest(intended.toString('utf8').replaceAll('\r\n', '\n')) !== LOCAL_CONTEXT_MIGRATION_SHA256)
    throw Error('LOCAL_RETENTION_MIGRATION_SOURCE_CHANGED');
  if (history.some(row => !row.finished_at && !row.rolled_back_at)) throw Error('LOCAL_RETENTION_HISTORY_REQUIRES_REVIEW');
  const successful = history.filter(row => row.finished_at && !row.rolled_back_at);
  if (new Set(successful.map(row => row.migration_name)).size !== successful.length
    || successful.some(row => !sources.has(row.migration_name))) throw Error('LOCAL_RETENTION_HISTORY_SOURCE_MISMATCH');
  const pending: string[] = [];
  for (const [name, bytes] of sources) {
    const prior = successful.find(row => row.migration_name === name);
    if (!prior) pending.push(name);
    else if (prior.checksum !== localMigrationDigest(bytes)
      && prior.checksum !== localMigrationDigest(bytes.toString('utf8').replaceAll('\r\n', '\n'))) throw Error('LOCAL_RETENTION_HISTORICAL_CHECKSUM_CHANGED');
  }
  if (pending.length > 1 || pending.some(name => name !== LOCAL_CONTEXT_MIGRATION)) throw Error('LOCAL_RETENTION_OTHER_MIGRATIONS_PENDING');
  return { pending: pending.length === 1, successful: successful.length };
}
