const TRANSIENT_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
]);

export function isTransientDatabaseConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof candidate.code === "string" && TRANSIENT_CONNECTION_CODES.has(candidate.code.toUpperCase())) {
    return true;
  }

  const message = [candidate.message, candidate.cause]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /can't reach database server|connection (?:reset|terminated|closed)|read ECONNRESET|socket hang up|timed out/i.test(message);
}

function isDroppedDatabaseConnection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (typeof candidate.code === "string" && ["ECONNRESET", "EPIPE", "P1017"].includes(candidate.code.toUpperCase())) {
    return true;
  }
  return typeof candidate.message === "string"
    && /connection (?:reset|terminated|closed)|read ECONNRESET|socket hang up/i.test(candidate.message);
}

// Only use for idempotent reads. A dropped connection can leave a write's
// commit outcome unknown, so mutations must not be replayed automatically.
export async function retryTransientDatabaseRead<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    // A timed-out query may still be running on the server; do not replay it.
    if (!isDroppedDatabaseConnection(error)) throw error;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    return query();
  }
}
