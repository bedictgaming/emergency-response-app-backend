import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { normalizeDatabaseUrl } from "@/lib/database-url";
import { decryptBackup, loadBackupKey } from "@/lib/backup-crypto";
import { requireRestorableBackup, restoreLogicalBackup } from "@/lib/logical-backup";

const sourceFile = process.argv[2] && path.resolve(process.argv[2]);
const rawRestoreUrl = process.env.RESTORE_DATABASE_URL;
if (!sourceFile || !rawRestoreUrl) throw new Error("Usage: set RESTORE_DATABASE_URL and CONFIRM_RESTORE_DATABASE to a disposable database, then pass the encrypted backup path");
const target = new URL(normalizeDatabaseUrl(rawRestoreUrl));
const targetName = decodeURIComponent(target.pathname.slice(1));
if (process.env.CONFIRM_RESTORE_DATABASE !== targetName || !/(?:test|staging|disposable)/i.test(targetName)) throw new Error("Exact disposable restore database confirmation is required");
if (process.env.DATABASE_URL) {
  const active = new URL(normalizeDatabaseUrl(process.env.DATABASE_URL));
  if (active.hostname.toLowerCase() === target.hostname.toLowerCase()
    && (active.port || "5432") === (target.port || "5432")
    && decodeURIComponent(active.pathname) === decodeURIComponent(target.pathname)) {
    throw new Error("Refusing to restore over DATABASE_URL; use a separate disposable database");
  }
}
const backup = requireRestorableBackup(JSON.parse(decryptBackup(await readFile(sourceFile), await loadBackupKey()).toString("utf8")));
const client = new pg.Client({ connectionString: target.toString() });
await client.connect();
try {
  console.log(`Restored ${await restoreLogicalBackup(client, backup)} tables into the disposable target.`);
} finally {
  await client.end();
}
