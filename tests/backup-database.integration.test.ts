/**
 * Actual backup/restore CLI regression. Only explicit isolated loopback targets;
 * no production snapshot, key, provider, workers or private records.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";
import { captureLogicalBackup, restoreLogicalBackup } from "@/lib/logical-backup";
import { decryptBackup, encryptBackup } from "@/lib/backup-crypto";

const suite = describe.runIf(process.env.RUN_NATIVE_BACKUP_TESTS === "1");
let source: pg.Client, target: pg.Client, directory: string, key: Buffer, sourceUrl: string, targetUrl: string;
const schema = `
  CREATE TABLE backup_codec_parent (id text PRIMARY KEY);
  CREATE TABLE backup_codec_probe (
    id text PRIMARY KEY, parent_id text REFERENCES backup_codec_parent(id) DEFERRABLE INITIALLY IMMEDIATE,
    wall timestamp(6), short_wall timestamp(3), instant timestamptz(6), calendar date,
    clock time(6), zoned_clock timetz(6), duration interval,
    walls timestamp(6)[], instants timestamptz(6)[], calendars date[],
    data jsonb, json_data json, text_array text[], binary bytea, number numeric(30,9), big bigint, floating double precision,
    flag boolean, nullable text
  );
  INSERT INTO backup_codec_parent VALUES ('synthetic-parent');
  INSERT INTO backup_codec_probe VALUES (
    'synthetic-only','synthetic-parent','2026-11-01 01:30:00.123456','2026-01-01 12:00:00.123',
    '2026-11-01 01:30:00.654321-04','2026-01-01','23:59:59.123456','12:34:56.123456+08','1 mon 2 days 03:04:05.123456',
    ARRAY['2026-03-08 02:30:00.123456'::timestamp,'2026-11-01 01:30:00.654321'::timestamp,NULL],
    ARRAY['2026-11-01 01:30:00.123456-04'::timestamptz,'2026-11-01 01:30:00.123456-05'::timestamptz],
    ARRAY['2026-01-01'::date,NULL], '[1,{"é":true},null]'::jsonb, ' [1, {"spaces": true}, null] '::json,
    ARRAY['comma,value','quote"value','brace{value}',NULL,'NULL','é'], decode('00ff5c','hex'),
    12345678901234567890.123456789,9223372036854775807,1.2345678901234567,true,NULL
  );
  INSERT INTO backup_codec_probe (id,wall,instant,calendar,clock,data,flag)
    VALUES ('synthetic-edge','infinity','-infinity','0001-01-01 BC','24:00:00','"scalar"'::jsonb,false),
           ('synthetic-null',NULL,NULL,NULL,NULL,'null'::jsonb,NULL);
`;
function guard(value: string | undefined, name: string | undefined) {
  const url = new URL(value || "");
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
    || !/disposable/.test(url.pathname) || decodeURIComponent(url.pathname.slice(1)) !== name) throw Error("LOOPBACK_BACKUP_TARGET_REQUIRED");
  return value!;
}
async function cli(script: string, args: string[] = [], extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, { NODE_ENV: "test", TZ: "UTC", DOTENV_CONFIG_PATH: join(directory, "no-dotenv"),
    DOTENV_CONFIG_QUIET: "true", DATABASE_URL: sourceUrl, RESTORE_DATABASE_URL: targetUrl,
    CONFIRM_RESTORE_DATABASE: decodeURIComponent(new URL(targetUrl).pathname.slice(1)), BACKUP_ENCRYPTION_KEY: key.toString("base64"), ...extra });
  return new Promise<{ code: number | null; output: string }>((yes, no) => {
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", script, ...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
    const timer = setTimeout(() => { child.kill(); no(Error("SYNTHETIC_CLI_TIMEOUT")); }, 30_000);
    child.on("error", () => { clearTimeout(timer); no(Error("SYNTHETIC_CLI_UNAVAILABLE")); });
    child.on("close", code => { clearTimeout(timer); yes({ code, output }); });
  });
}
async function backup(timezone: string) {
  const folder = join(directory, randomBytes(8).toString("hex")); await mkdir(folder);
  const result = await cli("src/backup-database.ts", [folder], { TZ: timezone });
  expect(result.code).toBe(0);
  const file = result.output.trim();
  expect(resolve(file, "..")).toBe(resolve(folder));
  const verify = await cli("scripts/verify-encrypted-backup.ts", [file, "--max-age-hours", "1"]);
  expect(verify.code).toBe(0);
  expect(JSON.parse(verify.output).losslessCodec).toBe(true);
  return { file, payload: JSON.parse(decryptBackup(await readFile(file), key).toString("utf8")) };
}
const canonical = (tables: Record<string, object[]>) => Object.fromEntries(Object.entries(tables).map(([name, rows]) =>
  [name, rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).sort()]));
async function captured(client: pg.Client) { return captureLogicalBackup(client, { host: "127.0.0.1", database: "synthetic_disposable" }); }

suite("native PostgreSQL lossless backup recovery", () => {
  beforeAll(async () => {
    sourceUrl = guard(process.env.DISPOSABLE_DATABASE_URL, process.env.CONFIRM_DISPOSABLE_DATABASE);
    targetUrl = guard(process.env.RESTORE_DATABASE_URL, process.env.CONFIRM_RESTORE_DATABASE);
    if (sourceUrl === targetUrl || process.env.DATABASE_URL !== sourceUrl) throw Error("SEPARATE_SYNTHETIC_BACKUP_TARGETS_REQUIRED");
    directory = await realpath(process.env.NATIVE_BACKUP_DIRECTORY || "");
    if (/onedrive/i.test(directory) || !/local-backup-repair-20261012-/.test(directory)) throw Error("PRIVATE_LOCAL_BACKUP_DIRECTORY_REQUIRED");
    key = randomBytes(32); source = new pg.Client({ connectionString: sourceUrl }); target = new pg.Client({ connectionString: targetUrl });
    await source.connect(); await target.connect();
    for (const client of [source, target]) {
      expect((await client.query("SELECT host(inet_server_addr()) AS addr")).rows[0].addr).toBe("127.0.0.1");
      expect((await client.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count).toBe(24);
      // Authenticated encrypted snapshot precedes synthetic fixture DDL as well.
      const payload = Buffer.from(JSON.stringify(await captured(client)));
      const encrypted = encryptBackup(payload, key);
      expect(decryptBackup(encrypted, key)).toEqual(payload);
      await writeFile(join(directory, randomBytes(8).toString("hex") + ".json.enc"), encrypted, { flag: "wx", mode: 0o600 });
      await client.query(schema);
    }
  }, 60_000);
  afterAll(async () => {
    for (const client of [source, target]) if (client) {
      await client.query("DROP TABLE IF EXISTS backup_codec_probe, backup_codec_parent").catch(() => {});
      await client.end();
    }
    key?.fill(0); // Owner operator shuts down/removes the exact temporary directory.
  });
  it("records exact type/precision, arrays, JSON, bytea, big numbers and temporal edge values", async () => {
    const { payload } = await backup("Asia/Manila");
    expect(Object.keys(payload.tables)).toHaveLength(26);
    const row = payload.tables.backup_codec_probe.find((r: any) => r.id === "synthetic-only");
    expect(row.wall).toBe("2026-11-01 01:30:00.123456");
    expect(row.short_wall).toBe("2026-01-01 12:00:00.123");
    expect(row.instant).toBe("2026-11-01 05:30:00.654321+00");
    expect(row.big).toBe("9223372036854775807");
    expect(row.number).toBe("12345678901234567890.123456789");
    expect(row.binary).toBe("\\x00ff5c");
    expect(row.nullable).toBeNull();
    expect(typeof row.data).toBe("string");
    expect(payload.columns.backup_codec_probe.find((c: any) => c.name === "wall").type).toBe("timestamp(6) without time zone");
  }, 60_000);
  it.each([["Asia/Manila", "America/Los_Angeles"], ["UTC", "Asia/Manila"], ["America/New_York", "UTC"]])("round-trips every field across %s to %s, including repeated restores", async (encoder, decoder) => {
    const { file, payload } = await backup(encoder);
    for (let repeat = 0; repeat < 2; repeat++) {
      expect((await cli("src/restore-database.ts", [file], { TZ: decoder })).code).toBe(0);
      expect(canonical((await captured(target)).tables)).toEqual(canonical(payload.tables));
    }
    expect((await target.query("SELECT condeferrable AS d, condeferred AS i FROM pg_constraint WHERE conname='backup_codec_probe_parent_id_fkey'")).rows).toEqual([{ d: true, i: false }]);
    expect((await target.query("SELECT count(*)::int AS count FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated")).rows[0].count).toBe(0);
  }, 90_000);
  it("rejects a legacy backup without changing the disposable target", async () => {
    const before = canonical((await captured(target)).tables);
    const file = join(directory, "legacy-synthetic.json.enc");
    await writeFile(file, encryptBackup(Buffer.from(JSON.stringify({ format: "emergency-response-logical-backup-v1", createdAt: new Date().toISOString(), tables: { backup_codec_probe: [{ wall: "2026-01-01T04:00:00Z" }] } })), key));
    expect((await cli("scripts/verify-encrypted-backup.ts", [file])).code).toBe(0);
    const result = await cli("src/restore-database.ts", [file]);
    expect(result.code).not.toBe(0); expect(result.output).toContain("separately reviewed recovery plan");
    expect(canonical((await captured(target)).tables)).toEqual(before);
  });
  it("rejects a type mismatch before truncation and preserves all rows", async () => {
    const value = await captured(source); const before = canonical((await captured(target)).tables);
    value.columns.backup_codec_probe.find(c => c.name === "wall")!.type = "timestamp(3) without time zone";
    await expect(restoreLogicalBackup(target, value)).rejects.toThrow(/column types/);
    expect(canonical((await captured(target)).tables)).toEqual(before);
  });
  it("rolls back a foreign-key failure without losing rows or original constraint settings", async () => {
    const value = await captured(source); const before = canonical((await captured(target)).tables);
    value.tables.backup_codec_probe.find(r => r.id === "synthetic-only")!.parent_id = "missing-synthetic-parent";
    await expect(restoreLogicalBackup(target, value)).rejects.toMatchObject({ code: "23503" });
    expect(canonical((await captured(target)).tables)).toEqual(before);
    expect((await target.query("SELECT condeferrable AS d, condeferred AS i FROM pg_constraint WHERE conname='backup_codec_probe_parent_id_fkey'")).rows).toEqual([{ d: true, i: false }]);
  });
  it("refuses active database aliases and missing explicit restore confirmation", async () => {
    const { file } = await backup("UTC"); const before = canonical((await captured(target)).tables);
    const equivalent = new URL(targetUrl); equivalent.searchParams.set("application_name", "synthetic-alias");
    expect((await cli("src/restore-database.ts", [file], { DATABASE_URL: equivalent.toString() })).code).not.toBe(0);
    expect((await cli("src/restore-database.ts", [file], { CONFIRM_RESTORE_DATABASE: "" })).code).not.toBe(0);
    expect(canonical((await captured(target)).tables)).toEqual(before);
  }, 60_000);
  it("fails closed for sequence-backed schemas instead of claiming incomplete recovery", async () => {
    await source.query("CREATE SEQUENCE backup_codec_unsupported");
    try { await expect(captured(source)).rejects.toThrow(/Sequence-backed/); }
    finally { await source.query("DROP SEQUENCE backup_codec_unsupported"); }
  });
});
