import type pg from "pg";

export const LOGICAL_BACKUP_FORMAT = "emergency-response-logical-backup-v2";
export const LEGACY_BACKUP_FORMAT = "emergency-response-logical-backup-v1";
export const LEGACY_RESTORE_ERROR = "Legacy v1 backups do not record their encoder timezone or lossless PostgreSQL types. Restore requires a separately reviewed recovery plan; the original backup is unchanged.";
export type BackupColumn = { name: string; type: string };
export type LogicalBackup = {
  format: typeof LOGICAL_BACKUP_FORMAT;
  encoding: "postgres-text-v1";
  createdAt: string;
  source: { host: string; database: string };
  columns: Record<string, BackupColumn[]>;
  tables: Record<string, Record<string, string | null>[]>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (a: object, b: object) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
export const quoteBackupIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tableSql = (name: string) => `"public".${quoteBackupIdentifier(name)}`;

/** Authentication is separate from recovery suitability. Legacy files remain inspectable. */
export function validateLogicalBackup(value: unknown): asserts value is LogicalBackup | { format: typeof LEGACY_BACKUP_FORMAT; createdAt: string; tables: Record<string, Record<string, unknown>[]> } {
  if (!record(value) || ![LOGICAL_BACKUP_FORMAT, LEGACY_BACKUP_FORMAT].includes(String(value.format))
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || !record(value.tables) || !Object.values(value.tables).every(rows => Array.isArray(rows) && rows.every(record))) {
    throw new Error("Invalid logical backup");
  }
  if (value.format === LEGACY_BACKUP_FORMAT) return;
  if (value.encoding !== "postgres-text-v1" || !record(value.columns) || !sameKeys(value.tables, value.columns)
    || !record(value.source) || typeof value.source.host !== "string" || typeof value.source.database !== "string") {
    throw new Error("Invalid PostgreSQL text backup metadata");
  }
  for (const [table, rows] of Object.entries(value.tables)) {
    const columns = value.columns[table];
    if (!table || !Array.isArray(columns) || !columns.length
      || !columns.every(c => record(c) && typeof c.name === "string" && c.name.length && typeof c.type === "string" && c.type.length)
      || new Set(columns.map(c => c.name)).size !== columns.length) throw new Error("Invalid backup columns");
    const names = columns.map(c => c.name).sort();
    for (const row of rows as Record<string, unknown>[]) {
      if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(names)
        || !Object.values(row).every(v => v === null || typeof v === "string")) throw new Error("Invalid PostgreSQL text row");
    }
  }
}

export function requireRestorableBackup(value: unknown): LogicalBackup {
  validateLogicalBackup(value);
  if (value.format === LEGACY_BACKUP_FORMAT) throw new Error(LEGACY_RESTORE_ERROR);
  return value;
}

async function textSettings(client: pg.Client) {
  // Both ends use PostgreSQL's text codec, never JavaScript Date/JSON/array parsers.
  await client.query("SET LOCAL TimeZone = 'UTC'; SET LOCAL DateStyle = 'ISO, YMD'; SET LOCAL IntervalStyle = 'postgres'; SET LOCAL extra_float_digits = 3; SET LOCAL bytea_output = 'hex'; SET LOCAL search_path = public, pg_catalog");
}

async function columnsFor(client: pg.Client, table: string): Promise<BackupColumn[]> {
  const result = await client.query<{ name: string; type: string; generated: string; identity: string }>(`
    SELECT a.attname::text AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
      a.attgenerated::text AS generated, a.attidentity::text AS identity
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [table]);
  // This application's schema has no generated/identity columns or sequences.
  // Fail closed instead of claiming a complete recovery for an unsupported schema.
  if (!result.rows.length || result.rows.some(c => c.generated || c.identity)) throw new Error("Unsupported backup table schema");
  return result.rows.map(({ name, type }) => ({ name, type }));
}

async function tableNames(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
  if (Number((await client.query("SELECT count(*)::int AS count FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'")).rows[0].count)) {
    throw new Error("Sequence-backed schemas require a separately reviewed backup codec");
  }
  return result.rows.map(r => r.table_name);
}

export async function captureLogicalBackup(client: pg.Client, source: LogicalBackup["source"]): Promise<LogicalBackup> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await textSettings(client);
    const tables: LogicalBackup["tables"] = Object.create(null);
    const columns: LogicalBackup["columns"] = Object.create(null);
    for (const table of await tableNames(client)) {
      // Prevent schema drift between metadata and values within this snapshot.
      await client.query(`LOCK TABLE ${tableSql(table)} IN ACCESS SHARE MODE`);
      columns[table] = await columnsFor(client, table);
      const selections = columns[table].map(c => `${quoteBackupIdentifier(c.name)}::text AS ${quoteBackupIdentifier(c.name)}`);
      tables[table] = (await client.query(`SELECT ${selections.join(", ")} FROM ${tableSql(table)}`)).rows;
    }
    const backup: LogicalBackup = { format: LOGICAL_BACKUP_FORMAT, encoding: "postgres-text-v1", createdAt: new Date().toISOString(), source, columns, tables };
    validateLogicalBackup(backup);
    await client.query("COMMIT");
    return backup;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function restoreLogicalBackup(client: pg.Client, input: unknown): Promise<number> {
  const backup = requireRestorableBackup(input); // Refuse ambiguous legacy files before any SQL.
  await client.query("BEGIN");
  try {
    await textSettings(client);
    const names = await tableNames(client);
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(backup.tables).sort())) throw new Error("Restore target table set does not match backup");
    for (const table of names) {
      await client.query(`LOCK TABLE ${tableSql(table)} IN ACCESS EXCLUSIVE MODE`);
      if (JSON.stringify(await columnsFor(client, table)) !== JSON.stringify(backup.columns[table])) throw new Error("Restore target column types do not match backup");
    }
    const constraints = (await client.query<{ table_name: string; constraint_name: string; deferrable: boolean; deferred: boolean }>(`
      SELECT c.relname::text AS table_name, k.conname::text AS constraint_name,
        k.condeferrable AS deferrable, k.condeferred AS deferred
      FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND k.contype='f'`)).rows;
    for (const c of constraints) await client.query(`ALTER TABLE ${tableSql(c.table_name)} ALTER CONSTRAINT ${quoteBackupIdentifier(c.constraint_name)} DEFERRABLE INITIALLY DEFERRED`);
    if (names.length) await client.query(`TRUNCATE ${names.map(tableSql).join(", ")} RESTART IDENTITY`);
    for (const table of names) {
      const columns = backup.columns[table].map(c => c.name);
      for (const row of backup.tables[table]) {
        const values = columns.map(c => row[c]);
        await client.query(`INSERT INTO ${tableSql(table)} (${columns.map(quoteBackupIdentifier).join(", ")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")})`, values);
      }
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const c of constraints) await client.query(`ALTER TABLE ${tableSql(c.table_name)} ALTER CONSTRAINT ${quoteBackupIdentifier(c.constraint_name)} ${c.deferrable ? `DEFERRABLE INITIALLY ${c.deferred ? "DEFERRED" : "IMMEDIATE"}` : "NOT DEFERRABLE"}`);
    await client.query("COMMIT");
    return names.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
