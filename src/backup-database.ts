import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { normalizeDatabaseUrl } from "@/lib/database-url";
import { encryptBackup, loadBackupKey } from "@/lib/backup-crypto";

const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);
const outputDirectory = path.resolve(process.argv[2] || path.join(process.cwd(), "..", ".database-backups"));
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const outputFile = path.join(outputDirectory, `emergency-response-${stamp}.json.enc`);
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const backupKey = await loadBackupKey();
const client = new pg.Client({ connectionString });
await client.connect();
let transactionOpen = false;
try {
  // Keep every table on the same point-in-time snapshot while writes continue.
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  transactionOpen = true;
  const tableResult = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const tables: Record<string, unknown[]> = {};
  for (const { table_name: table } of tableResult.rows) {
    tables[table] = (await client.query(`SELECT * FROM ${quote(table)}`)).rows;
  }
  await client.query("COMMIT");
  transactionOpen = false;
  const database = new URL(connectionString);
  await mkdir(outputDirectory, { recursive: true });
  const plaintext = Buffer.from(JSON.stringify({
    format: "emergency-response-logical-backup-v1",
    createdAt: new Date().toISOString(),
    source: { host: database.hostname, database: database.pathname.slice(1) },
    tables,
  }));
  await writeFile(outputFile, encryptBackup(plaintext, backupKey), { flag: "wx", mode: 0o600 });
  console.log(outputFile);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
