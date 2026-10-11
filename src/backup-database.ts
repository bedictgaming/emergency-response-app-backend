import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { normalizeDatabaseUrl } from "@/lib/database-url";
import { encryptBackup, loadBackupKey } from "@/lib/backup-crypto";
import { captureLogicalBackup } from "@/lib/logical-backup";

const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);
const outputDirectory = path.resolve(process.argv[2] || path.join(process.cwd(), "..", ".database-backups"));
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const outputFile = path.join(outputDirectory, `emergency-response-${stamp}.json.enc`);
const backupKey = await loadBackupKey();
const client = new pg.Client({ connectionString });
await client.connect();
try {
  const database = new URL(connectionString);
  const backup = await captureLogicalBackup(client, { host: database.hostname, database: database.pathname.slice(1) });
  await mkdir(outputDirectory, { recursive: true });
  const plaintext = Buffer.from(JSON.stringify(backup));
  await writeFile(outputFile, encryptBackup(plaintext, backupKey), { flag: "wx", mode: 0o600 });
  console.log(outputFile);
} finally {
  await client.end();
}
