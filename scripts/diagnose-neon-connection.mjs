/**
 * Bounded, read-only PostgreSQL connection probe for comparing networks.
 * Run from the backend directory; never print a connection URL or query data.
 */
import "dotenv/config";
import pg from "pg";
import { performance } from "node:perf_hooks";

const TIMEOUT_MS = 8_000;

async function closeClient(client) {
  let timer;
  try {
    await Promise.race([
      client.end(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("CLEANUP_TIMEOUT")), 3_000);
      }),
    ]);
  } catch {
    // The probe must not remain open indefinitely after a dropped connection.
    client.connection?.stream?.destroy();
  } finally {
    clearTimeout(timer);
  }
}

const samples = Number(process.argv[2] ?? 3);
if (!Number.isInteger(samples) || samples < 1 || samples > 10) {
  console.error("Usage: node scripts/diagnose-neon-connection.mjs [1-10 samples]");
  process.exitCode = 2;
} else {
  const results = {};

  for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
    const raw = process.env[name];
    if (!raw) {
      results[name] = { configured: false };
      continue;
    }

    let url;
    try {
      url = new URL(raw);
    } catch {
      results[name] = { configured: true, error: "Invalid connection URL" };
      continue;
    }
    if (["prefer", "require", "verify-ca"].includes(url.searchParams.get("sslmode"))) {
      url.searchParams.set("sslmode", "verify-full");
    }

    const attempts = [];
    for (let index = 0; index < samples; index += 1) {
      const client = new pg.Client({
        connectionString: url.toString(),
        connectionTimeoutMillis: TIMEOUT_MS,
        query_timeout: TIMEOUT_MS,
        statement_timeout: TIMEOUT_MS,
        keepAlive: true,
      });
      // pg may emit an error while the client is idle or shutting down.
      client.on("error", () => undefined);
      const started = performance.now();
      const startedAt = new Date().toISOString();
      let phase = "connect";
      try {
        await client.connect();
        const connected = performance.now();
        phase = "query";
        await client.query("SELECT 1");
        attempts.push({
          result: "ok",
          startedAt,
          connectMs: Math.round(connected - started),
          queryMs: Math.round(performance.now() - connected),
        });
      } catch (error) {
        attempts.push({
          result: "failed",
          startedAt,
          phase,
          elapsedMs: Math.round(performance.now() - started),
          code: typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)
            ? error.code : "UNKNOWN",
          kind: /timeout/i.test(String(error?.message)) ? "timeout"
            : /tls|socket|connection.*terminat/i.test(String(error?.message)) ? "disconnect"
              : "other",
        });
      } finally {
        await closeClient(client);
      }
      if (index + 1 < samples) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    results[name] = {
      configured: true,
      endpoint: url.hostname.includes("pooler") ? "pooled" : "direct",
      attempts,
    };
  }

  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), samples, results }, null, 2));
  if (Object.values(results).some((result) => result.attempts?.some((attempt) => attempt.result === "failed"))) {
    process.exitCode = 1;
  }
}
