import { isIP } from 'node:net';
import { Prisma } from '@/generated/prisma';
import { ENV } from '@/config/env';

export const REPORT_CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Server-derived transport context. Browser strings and shared IPs are NOT identity proof. */
export function reportRequestContext(ip?: string, userAgent?: string) {
  return { ipAddress: ip && ip.length <= 45 && isIP(ip) ? ip : undefined,
    userAgent: userAgent?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 384) || undefined };
}

/** Same transaction as the successful receipt. Never copy raw context into AuditLog. */
export async function storeReportRequestContext(
  tx: Prisma.TransactionClient,
  receipt: { auditLogId: string },
  context?: { ipAddress?: string; userAgent?: string },
) {
  if (!ENV.REPORT_REQUEST_CONTEXT_ENABLED) return;
  const normalized = reportRequestContext(context?.ipAddress, context?.userAgent);
  if (!normalized.ipAddress && !normalized.userAgent) return;
  // Existing audit timestamps lack a timezone and may have been created by
  // different session conventions. Capture the actual database instant here;
  // never reinterpret old timestamps or renew the deadline on a later read.
  await tx.$executeRaw`
    WITH captured AS (SELECT statement_timestamp()::timestamptz(3) AS instant)
    INSERT INTO report_request_contexts(audit_log_id, captured_at, expires_at, ip_address, user_agent)
    SELECT ${receipt.auditLogId}::uuid, instant, instant + INTERVAL '720 hours',
      ${normalized.ipAddress ?? null}, ${normalized.userAgent ?? null} FROM captured
  `;
}

/** Caller must authorize the account first and pass its bounded receipt IDs.
 * Expired fields are withheld even if cleanup is late or an old backup is restored.
 * No fallback to legacy raw AuditLog fields: those need separate owner disposition.
 */
export async function recentReportRequestContexts(tx: Prisma.TransactionClient, receiptIds: string[]) {
  if (!ENV.REPORT_REQUEST_CONTEXT_ENABLED || !receiptIds.length) return new Map<string, { ipAddress: string | null; userAgent: string | null }>();
  if (receiptIds.length > 20) throw new Error('REPORT_CONTEXT_READ_BOUND_EXCEEDED');
  const rows = await tx.$queryRaw<Array<{ auditLogId: string; ipAddress: string | null; userAgent: string | null }>>`
    SELECT audit_log_id::text AS "auditLogId", ip_address AS "ipAddress", user_agent AS "userAgent"
    FROM report_request_contexts
    WHERE audit_log_id IN (${Prisma.join(receiptIds.map(id => Prisma.sql`${id}::uuid`))})
      AND expires_at > statement_timestamp()
  `;
  return new Map(rows.map(row => [row.auditLogId, { ipAddress: row.ipAddress, userAgent: row.userAgent }]));
}
