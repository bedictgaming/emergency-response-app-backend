import type { Prisma } from '@/generated/prisma';
import { ENV } from '@/config/env';
import { prisma } from '@/lib/prisma';
import { reportContextWorkerEnabled } from '@/config/report-context-worker';

export const REPORT_CONTEXT_BATCH_SIZE = 250;

/** Aggregate-only, read-only preview. No row IDs, IP/browser values or provider errors. */
export async function previewReportContextExpiry(tx: Prisma.TransactionClient) {
  const [summary] = await tx.$queryRaw<Array<{ expired: number; oldestExpiry: Date | null }>>`
    SELECT count(*)::integer AS expired, min(expires_at) AT TIME ZONE 'UTC' AS "oldestExpiry"
    FROM report_request_contexts WHERE expires_at <= statement_timestamp()
  `;
  return summary;
}

/** Inventory only, for a separately approved legacy disposition. Never redact
 * immutable audits here or imply that hiding them has disposed of stored copies.
 */
export async function previewLegacyReportContext(tx: Prisma.TransactionClient) {
  return tx.$queryRaw<Array<{ action: string; records: number; overThirtyDays: number }>>`
    SELECT action, count(*)::integer AS records,
      count(*) FILTER (WHERE created_at <= (statement_timestamp() AT TIME ZONE 'UTC') - INTERVAL '720 hours')::integer AS "overThirtyDays"
    FROM audit_logs WHERE entity_type = 'Incident'
      AND action IN ('INCIDENT_CREATED', 'INCIDENT_DUPLICATE_OVERRIDE')
      AND (ip_address IS NOT NULL OR jsonb_typeof(metadata->'userAgent') = 'string')
    GROUP BY action ORDER BY action
  `;
}

/** A bounded, retry-safe disposal of transport context ONLY. No AuditLog mutation.
 * SKIP LOCKED allows concurrent workers without waiting on a busy context row.
 * Low-level transaction helper is also exercised on synthetic native PostgreSQL.
 */
export async function expireReportContextBatch(tx: Prisma.TransactionClient) {
  const [result] = await tx.$queryRaw<Array<{ deleted: number }>>`
    WITH expired AS (
      SELECT audit_log_id FROM report_request_contexts
      WHERE expires_at <= statement_timestamp()
      ORDER BY expires_at, audit_log_id LIMIT ${REPORT_CONTEXT_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM report_request_contexts AS context USING expired
      WHERE context.audit_log_id = expired.audit_log_id
        AND context.expires_at <= statement_timestamp()
      RETURNING 1
    ) SELECT count(*)::integer AS deleted FROM removed
  `;
  return result;
}

let processing = false;
export async function processExpiredReportContexts() {
  if (!reportContextWorkerEnabled(ENV)) return { status: 'disabled' as const };
  if (processing) return { status: 'busy' as const };
  processing = true;
  try {
    const result = await prisma.$transaction(tx => expireReportContextBatch(tx));
    return { status: 'applied' as const, ...result };
  } finally { processing = false; }
}

/** Called only by the server bootstrap, never on import. Local retention can run
 * independently; general notification/evidence job gates remain untouched.
 */
export function startReportContextRetentionWorker() {
  if (!reportContextWorkerEnabled(ENV)) return;
  const run = () => void processExpiredReportContexts().catch(() => {
    console.error('[request-context] Retention batch failed; operator review required');
  });
  run();
  const timer = setInterval(run, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
