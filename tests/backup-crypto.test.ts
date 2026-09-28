import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptBackup, encryptBackup } from "@/lib/backup-crypto";

describe("encrypted database backups", () => {
  it("round-trips without exposing table contents", () => {
    const key = crypto.randomBytes(32);
    const plaintext = Buffer.from('{"tables":{"Token":[{"token":"sensitive"}]}}');
    const encrypted = encryptBackup(plaintext, key);
    expect(encrypted.toString("utf8")).not.toContain("sensitive");
    expect(decryptBackup(encrypted, key)).toEqual(plaintext);
    expect(() => decryptBackup(encrypted, crypto.randomBytes(32))).toThrow();
  });

  it("refuses a legacy plaintext backup", () => {
    expect(() => decryptBackup(Buffer.from('{"format":"emergency-response-logical-backup-v1"}'), crypto.randomBytes(32))).toThrow(/plaintext backup/);
  });
});
