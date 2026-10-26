import type { Prisma } from '@/generated/prisma';

export const SAFETY_REVIEW_ACTIONS = [
  'INCIDENT_FLAGGED', 'INCIDENT_FLAG_REVIEWED', 'INCIDENT_FLAG_CORRECTED',
  'NEARBY_REPORT_ACKNOWLEDGED', 'NEARBY_REPORT_REJECTED',
];

/** Main-only presentation allowlist; never return arbitrary audit metadata. */
export function presentSafetyReviewAudit(row: {
  auditLogId: string; entityId: string | null; action: string; createdAt: Date;
  actor: { id: string; name: string | null } | null; metadata: Prisma.JsonValue;
}) {
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
  const string = (key: string) => typeof metadata[key] === 'string' ? metadata[key] as string : null;
  return { auditLogId: row.auditLogId, incidentId: row.entityId, action: row.action, createdAt: row.createdAt,
    actor: row.actor, reason: string('reviewNotes') ?? string('reason'),
    decision: string('status'), department: string('department') ?? string('service') };
}
