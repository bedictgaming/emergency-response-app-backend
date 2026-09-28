import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, Pool } from "pg";
import { ResilientPrismaPg } from "@/lib/resilient-prisma-pg";

describe("Prisma PostgreSQL idle pool resilience", () => {
  afterEach(() => vi.restoreAllMocks());

  it("handles an idle connection reset without printing connection details", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const factory = new ResilientPrismaPg({ connectionString: "postgresql://user:secret@localhost:5432/test" });
    const adapter = await factory.connect();
    const pool = (adapter as unknown as { client: Pool }).client;

    expect(pool).toBeInstanceOf(Pool);
    expect(pool.listenerCount("error")).toBe(1);
    expect(() => pool.emit("error", Object.assign(new Error("private connection detail"), { code: "ECONNRESET" }))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[database-pool] Idle connection lost (ECONNRESET); a new connection will be opened when needed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private connection detail");

    await adapter.dispose();
  });

  it("handles a checked-out client error and removes its listener on release", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const factory = new ResilientPrismaPg({ connectionString: "postgresql://user:secret@localhost:5432/test" });
    const adapter = await factory.connect();
    const pool = (adapter as unknown as { client: Pool }).client;
    const client = new Client();

    pool.emit("acquire", client);
    expect(client.listenerCount("error")).toBe(1);
    expect(() => client.emit("error", new Error("private connection detail"))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[database-pool] Active connection lost (UNKNOWN); the operation will fail and the connection will be replaced",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private connection detail");

    pool.emit("release", undefined, client);
    expect(client.listenerCount("error")).toBe(0);
    await adapter.dispose();
  });
});
