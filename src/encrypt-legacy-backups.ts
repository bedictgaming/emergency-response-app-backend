import crypto from "node:crypto";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { backupKeyLocation, decryptBackup, encryptBackup, loadBackupKey } from "@/lib/backup-crypto";

const directory = path.resolve(process.cwd(), "..", ".database-backups");
const key = await loadBackupKey(true);
const entries = await readdir(directory, { withFileTypes: true });
let plaintextRemaining = false;

for (const entry of entries) {
  if (!entry.isFile() || !/^emergency-response-[\w-]+\.json$/.test(entry.name)) continue;
  const source = path.join(directory, entry.name);
  const destination = `${source}.enc`;
  const plaintext = await readFile(source);
  const backup = JSON.parse(plaintext.toString("utf8")) as { format?: string };
  if (backup.format !== "emergency-response-logical-backup-v1") throw new Error(`Unexpected backup format: ${entry.name}`);
  try {
    await writeFile(destination, encryptBackup(plaintext, key), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const verified = decryptBackup(await readFile(destination), key);
  if (!crypto.timingSafeEqual(plaintext, verified)) throw new Error(`Encrypted backup verification failed: ${entry.name}`);
  try {
    await unlink(source);
    console.log(`Encrypted and verified ${entry.name}`);
  } catch (error) {
    plaintextRemaining = true;
    console.error(`Encrypted copy verified, but plaintext could not be removed: ${entry.name} (${(error as NodeJS.ErrnoException).code})`);
  }
}
console.log(`Recovery key: ${backupKeyLocation()} — keep a separate offline copy of this key.`);
if (plaintextRemaining) process.exitCode = 1;
