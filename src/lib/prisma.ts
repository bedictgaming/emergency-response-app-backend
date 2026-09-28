   import "dotenv/config";
   import { ResilientPrismaPg } from "@/lib/resilient-prisma-pg";
   import { PrismaClient } from "@/generated/prisma/client";
   import { normalizeDatabaseUrl } from "@/lib/database-url";

   const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);

// The outbox worker runs every 15 seconds and dashboards refresh on events.
// Keep a small pool warm between those reads instead of repeatedly opening
// remote PostgreSQL connections (node-postgres defaults to a 10-second idle
// timeout), while bounding the number of connections per backend instance.
const adapter = new ResilientPrismaPg({
  connectionString,
  max: 5,
  idleTimeoutMillis: 60_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});
   const prisma = new PrismaClient({
     adapter,
     // Remote PostgreSQL connections can exceed Prisma's 5-second interactive
     // transaction default during transient network latency. Keep the
     // transaction bounded while allowing the atomic workflow to finish.
     transactionOptions: { maxWait: 10_000, timeout: 20_000 },
   });

   export { prisma };
