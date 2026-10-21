import type { Prisma } from '@/generated/prisma';
import type { JwtPayload } from '@/lib/jwt';

export const confirmedFalseSanctionsEnabled = () => process.env.CONFIRMED_FALSE_SANCTIONS_ENABLED === 'true';
const DECISION = 'CITIZEN_FALSE_REPORT_DECISION';
const RESET = 'CITIZEN_FALSE_REPORT_RESET';
export const FALSE_REPORT_THRESHOLD = 3;

/** Acquire BEFORE actor/session and incident locks. Same ordering as user administration. */
export async function lockFalseReportParticipants(tx: Prisma.TransactionClient, incidentId: string, actor: JwtPayload) {
  if (!confirmedFalseSanctionsEnabled()) return;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('main-admin-bootstrap'))::text AS lock_token`;
  const incident = await tx.incident.findUnique({ where: { incidentId }, select: { reportedBy: true } });
  const reporter = incident?.reportedBy ?? actor.sub;
  await tx.$queryRaw`SELECT id FROM "User" WHERE id IN (${actor.sub}, ${reporter}) ORDER BY id FOR UPDATE`;
}

async function lastReceipt(tx: Prisma.TransactionClient, userId: string) {
  return tx.auditLog.findFirst({ where: { entityType: 'User', entityId: userId, action: { in: [DECISION, RESET] } },
    orderBy: [{ createdAt: 'desc' }, { auditLogId: 'desc' }], select: { createdAt: true } });
}

export async function resetConfirmedFalseSanctions(tx: Prisma.TransactionClient, userId: string, actorId: string) {
  if (!confirmedFalseSanctionsEnabled()) return;
  const previous = await lastReceipt(tx, userId);
  await tx.auditLog.create({ data: { actorId, action: RESET, entityType: 'User', entityId: userId,
    createdAt: new Date(Math.max(Date.now(), (previous?.createdAt.getTime() ?? 0) + 1)), metadata: { reason: 'MAIN_ADMIN_REACTIVATION' } } });
}

async function cycle(tx: Prisma.TransactionClient, userId: string) {
  return (await tx.auditLog.findFirst({ where: { entityType: 'User', entityId: userId, action: RESET },
    orderBy: [{ createdAt: 'desc' }, { auditLogId: 'desc' }], select: { auditLogId: true } }))?.auditLogId ?? 'initial';
}

/** Latest decision per distinct incident in this sanction cycle; never per department. */
export async function confirmedFalseSummary(tx: Prisma.TransactionClient, userId: string) {
  const cycleId = await cycle(tx, userId);
  const [row] = await tx.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM (
      SELECT DISTINCT ON (metadata->>'incidentId') metadata
      FROM audit_logs WHERE entity_type = 'User' AND entity_id = ${userId}
        AND action = ${DECISION} AND metadata->>'cycleId' = ${cycleId}
      ORDER BY metadata->>'incidentId', created_at DESC, audit_log_id DESC
    ) decisions WHERE metadata->>'confirmed' = 'true'`;
  return { enabled: confirmedFalseSanctionsEnabled(), confirmedFalseCount: Number(row?.count ?? 0), threshold: FALSE_REPORT_THRESHOLD };
}

/** Reporter User lock + incident lock must already be held. No historical backfill. */
export async function reconcileConfirmedFalseSanction(tx: Prisma.TransactionClient, incidentId: string, actorId: string): Promise<string | null> {
  if (!confirmedFalseSanctionsEnabled()) return null;
  const incident = await tx.incident.findUniqueOrThrow({ where: { incidentId }, select: {
    reportedBy: true, reviewFlags: { select: { status: true } }, nearbyReviews: { select: { status: true, service: true } },
    serviceResponses: { select: { service: true } },
  } });
  if (!incident.reportedBy) return null;
  const user = await tx.user.findUnique({ where: { id: incident.reportedBy }, select: { role: true } });
  if (user?.role !== 'USER') return null;
  // A single rejected lane must not punish a citizen whose other service is genuine.
  const confirmed = incident.reviewFlags.some(flag => flag.status === 'CONFIRMED')
    || (incident.serviceResponses.length > 0 && incident.nearbyReviews.length === incident.serviceResponses.length
      && incident.serviceResponses.every(response => incident.nearbyReviews.some(review => review.service === response.service && review.status === 'REJECTED')));
  const first = await tx.auditLog.findFirst({ where: { entityType: 'User', entityId: incident.reportedBy,
    action: DECISION, metadata: { path: ['incidentId'], equals: incidentId } },
    orderBy: [{ createdAt: 'asc' }, { auditLogId: 'asc' }], select: { metadata: true } });
  if (!first && !confirmed) return null;
  const cycleId = first ? (first.metadata as { cycleId: string }).cycleId : await cycle(tx, incident.reportedBy);
  const previous = await lastReceipt(tx, incident.reportedBy);
  await tx.auditLog.create({ data: { actorId, action: DECISION, entityType: 'User', entityId: incident.reportedBy,
    createdAt: new Date(Math.max(Date.now(), (previous?.createdAt.getTime() ?? 0) + 1)),
    metadata: { incidentId, cycleId, confirmed, version: 1 } } });
  const summary = await confirmedFalseSummary(tx, incident.reportedBy);
  if (summary.confirmedFalseCount < FALSE_REPORT_THRESHOLD) return null;
  const changed = await tx.user.updateMany({ where: { id: incident.reportedBy, role: 'USER', status: 'ACTIVE' }, data: { status: 'INACTIVE' } });
  if (!changed.count) return null;
  await tx.token.updateMany({ where: { userId: incident.reportedBy, revokedAt: null }, data: { revokedAt: new Date() } });
  await tx.responder.updateMany({ where: { userId: incident.reportedBy }, data: { status: 'OFF_DUTY' } });
  await tx.auditLog.create({ data: { actorId, action: 'CITIZEN_AUTO_DEACTIVATED', entityType: 'User', entityId: incident.reportedBy,
    metadata: { reasonCode: 'THREE_CONFIRMED_FALSE_REPORTS', threshold: FALSE_REPORT_THRESHOLD, cycleId } } });
  return incident.reportedBy;
}
