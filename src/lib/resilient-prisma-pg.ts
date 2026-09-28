import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

function safeErrorCode(error: Error & { code?: string }): string {
  return typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)
    ? error.code
    : "UNKNOWN";
}

// Prisma 6.12 creates the pg Pool internally. A disconnected idle client
// emits on the Pool, whereas a checked-out client emits on the Client after
// pg-pool removes its idle listener. Both need listeners: an active query still
// rejects normally, but an unhandled Client error would terminate the API.
function handlePoolErrors<T>(adapter: T): T {
  const pool = (adapter as { client?: unknown }).client;
  if (!(pool instanceof Pool)) {
    throw new Error("Prisma PostgreSQL adapter did not expose its expected pool");
  }

  pool.on("error", (error: Error & { code?: string }) => {
    // pg-pool removes the broken idle client itself. Do not log the client,
    // connection string, or raw error, which can contain private details.
    console.warn(`[database-pool] Idle connection lost (${safeErrorCode(error)}); a new connection will be opened when needed`);
  });

  const activeErrorListeners = new WeakMap<object, (error: Error & { code?: string }) => void>();
  pool.on("acquire", (client) => {
    if (activeErrorListeners.has(client)) return;
    const listener = (error: Error & { code?: string }) => {
      // Do not release here: Prisma/pg-pool own the failed query or transaction.
      // The listener only prevents an EventEmitter crash while it is checked out.
      console.warn(`[database-pool] Active connection lost (${safeErrorCode(error)}); the operation will fail and the connection will be replaced`);
    };
    activeErrorListeners.set(client, listener);
    client.on("error", listener);
  });
  pool.on("release", (_error, client) => {
    const listener = activeErrorListeners.get(client);
    if (!listener) return;
    client.removeListener("error", listener);
    activeErrorListeners.delete(client);
  });
  return adapter;
}

export class ResilientPrismaPg extends PrismaPg {
  override async connect() {
    return handlePoolErrors(await super.connect());
  }

  override async connectToShadowDb() {
    return handlePoolErrors(await super.connectToShadowDb());
  }
}
