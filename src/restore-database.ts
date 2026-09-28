import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { normalizeDatabaseUrl } from "@/lib/database-url";
import { decryptBackup, loadBackupKey } from "@/lib/backup-crypto";

const sourceFile = process.argv[2] && path.resolve(process.argv[2]);
const rawRestoreUrl = process.env.RESTORE_DATABASE_URL;
if (!sourceFile || !rawRestoreUrl) throw new Error("Usage: set RESTORE_DATABASE_URL to a disposable database, then pass the backup file path");
if (rawRestoreUrl === process.env.DATABASE_URL) throw new Error("Refusing to restore over DATABASE_URL; use a separate disposable database");
const connectionString = normalizeDatabaseUrl(rawRestoreUrl);
const backup = JSON.parse(decryptBackup(await readFile(sourceFile), await loadBackupKey()).toString("utf8")) as { format: string; tables: Record<string, Record<string, unknown>[]> };
if (backup.format !== "emergency-response-logical-backup-v1") throw new Error("Unsupported backup format");
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  const constraints = await client.query<{ table_name: string; constraint_name: string }>(`
    SELECT tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
  `);
  for (const constraint of constraints.rows) {
    await client.query(`ALTER TABLE ${quote(constraint.table_name)} ALTER CONSTRAINT ${quote(constraint.constraint_name)} DEFERRABLE INITIALLY DEFERRED`);
  }
  const tableNames = Object.keys(backup.tables);
  if (tableNames.length) await client.query(`TRUNCATE ${tableNames.map(quote).join(", ")} RESTART IDENTITY CASCADE`);
  for (const table of tableNames) {
    for (const row of backup.tables[table]) {
      const columns = Object.keys(row);
      if (!columns.length) continue;
      const values = columns.map((column) => row[column]);
      await client.query(`INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})`, values);
    }
  }
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  for (const constraint of constraints.rows) {
    await client.query(`ALTER TABLE ${quote(constraint.table_name)} ALTER CONSTRAINT ${quote(constraint.constraint_name)} NOT DEFERRABLE`);
  }
  await client.query("COMMIT");
  console.log(`Restored ${tableNames.length} tables into the disposable target.`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
