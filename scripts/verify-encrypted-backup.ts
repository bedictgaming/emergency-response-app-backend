import { readFile } from "node:fs/promises";
import { decryptBackup, loadBackupKey } from "../src/lib/backup-crypto";

const file = process.argv[2];
if (!file?.endsWith(".json.enc")) throw new Error("Supply an encrypted .json.enc backup file");
const backup = JSON.parse(decryptBackup(await readFile(file), await loadBackupKey()).toString("utf8"));
if (backup.format !== "emergency-response-logical-backup-v1" || !backup.tables || typeof backup.tables !== "object") throw new Error("Invalid logical backup");
const tables = Object.values(backup.tables) as unknown[][];
if (!tables.every(Array.isArray)) throw new Error("Invalid table data");
console.log(JSON.stringify({ verified: true, tables: tables.length, rows: tables.reduce((sum, rows) => sum + rows.length, 0) }));
