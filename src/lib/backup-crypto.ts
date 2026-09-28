import crypto from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FORMAT = "emergency-response-encrypted-backup-v1";
const KEY_FILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "EmergencyResponse", "backup-encryption.key");

type EncryptedBackup = {
  format: typeof FORMAT;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be 32 random bytes encoded as base64");
  return key;
}

export function backupKeyLocation(): string {
  return process.env.BACKUP_ENCRYPTION_KEY_FILE || KEY_FILE;
}

export async function loadBackupKey(createLocalKey = false): Promise<Buffer> {
  if (process.env.BACKUP_ENCRYPTION_KEY) return decodeKey(process.env.BACKUP_ENCRYPTION_KEY);
  const file = backupKeyLocation();
  try {
    return decodeKey(await readFile(file, "utf8"));
  } catch (error) {
    if (!createLocalKey || process.env.NODE_ENV === "production") {
      throw new Error(`Backup encryption key is unavailable. Set BACKUP_ENCRYPTION_KEY or BACKUP_ENCRYPTION_KEY_FILE (${file}).`, { cause: error });
    }
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(32);
    try {
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(key.toString("base64")); } finally { await handle.close(); }
      return key;
    } catch (createError) {
      // Another process may have created the key between the read and write.
      if ((createError as NodeJS.ErrnoException).code === "EEXIST") return decodeKey(await readFile(file, "utf8"));
      throw createError;
    }
  }
}

export function encryptBackup(plaintext: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(FORMAT));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: EncryptedBackup = {
    format: FORMAT,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope));
}

export function decryptBackup(encrypted: Buffer, key: Buffer): Buffer {
  const envelope = JSON.parse(encrypted.toString("utf8")) as EncryptedBackup;
  if (envelope.format !== FORMAT || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported or plaintext backup. Encrypt legacy backups before restoring.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(Buffer.from(FORMAT));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
}
