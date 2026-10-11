import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { LEGACY_RESTORE_ERROR, quoteBackupIdentifier, requireRestorableBackup, restoreLogicalBackup, validateLogicalBackup } from "@/lib/logical-backup";

const fixture = () => ({
  format: "emergency-response-logical-backup-v2", encoding: "postgres-text-v1", createdAt: "2026-01-01T00:00:00Z",
  source: { host: "127.0.0.1", database: "backup_disposable" },
  columns: { probe: [{ name: "at", type: "timestamp(6) without time zone" }, { name: "json", type: "jsonb" }] },
  tables: { probe: [{ at: "2026-01-01 12:00:00.123456", json: '[1,{"é":true},null]' }] },
});

describe("lossless PostgreSQL logical backup contract", () => {
  it("preserves exact strings, microseconds and JSON arrays without Date/JSON re-parsing", () => {
    const backup = requireRestorableBackup(JSON.parse(JSON.stringify(fixture())));
    expect(backup.tables.probe[0]).toEqual(fixture().tables.probe[0]);
  });
  it("authenticates legacy structure without claiming it is safe to restore", async () => {
    const legacy = { format: "emergency-response-logical-backup-v1", createdAt: "2026-01-01T00:00:00Z", tables: { probe: [{ at: "2026-01-01T04:00:00Z" }] } };
    expect(() => validateLogicalBackup(legacy)).not.toThrow();
    const client = { query: vi.fn() };
    await expect(restoreLogicalBackup(client as unknown as pg.Client, legacy)).rejects.toThrow(LEGACY_RESTORE_ERROR);
    expect(client.query).not.toHaveBeenCalled();
  });
  it.each(["missing-column", "extra-column", "numeric-value", "parsed-json", "duplicate-column", "missing-metadata", "wrong-encoding", "invalid-age"])("rejects malformed data: %s", mutation => {
    const value: any = fixture();
    if (mutation === "missing-column") delete value.tables.probe[0].at;
    if (mutation === "extra-column") value.tables.probe[0].extra = "not-declared";
    if (mutation === "numeric-value") value.tables.probe[0].at = 1;
    if (mutation === "parsed-json") value.tables.probe[0].json = [1];
    if (mutation === "duplicate-column") value.columns.probe.push(value.columns.probe[0]);
    if (mutation === "missing-metadata") delete value.columns.probe;
    if (mutation === "wrong-encoding") value.encoding = "javascript-values";
    if (mutation === "invalid-age") value.createdAt = "invalid";
    expect(() => requireRestorableBackup(value)).toThrow();
  });
  it("accepts SQL NULL without converting it to the string null", () => {
    const value: any = fixture(); value.tables.probe[0].at = null;
    expect(requireRestorableBackup(value).tables.probe[0].at).toBeNull();
  });
  it("quotes identifiers without interpolating their contents as SQL", () => {
    expect(quoteBackupIdentifier('x"; DROP TABLE probe; --')).toBe('"x""; DROP TABLE probe; --"');
  });
  it("refuses mismatched target schemas and rolls back before truncation", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("information_schema.tables")) return { rows: [{ table_name: "other" }] };
      if (sql.includes("relkind='S'")) return { rows: [{ count: 0 }] };
      return { rows: [] };
    });
    await expect(restoreLogicalBackup({ query } as unknown as pg.Client, fixture())).rejects.toThrow(/table set/);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => /TRUNCATE|ALTER TABLE|INSERT/.test(sql))).toBe(false);
  });
});
