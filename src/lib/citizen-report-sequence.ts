import { Prisma } from '@/generated/prisma';
import { WorkflowConflict } from '@/domain/workflow-error.policy';
import {
  CITIZEN_REPORT_SEQUENCE_ACTION, CITIZEN_REPORT_LIMIT_CODE, CITIZEN_REPORT_WINDOW_MS,
  citizenReportViolation, readCitizenReportSequence, type CitizenReportReceipt,
} from '@/domain/citizen-report-sequence.policy';

// Callers must already hold the target User row lock. The existing indexed
// audit stream persists across process restarts and report deletion.
async function lastState(tx: Prisma.TransactionClient, userId: string) {
  return tx.auditLog.findFirst({
    where: { entityType: 'User', entityId: userId, action: CITIZEN_REPORT_SEQUENCE_ACTION },
    orderBy: [{ createdAt: 'desc' }, { auditLogId: 'desc' }],
    select: { metadata: true, createdAt: true },
  });
}

// PostgreSQL now() is the transaction-start time, potentially before a lock
// wait. Explicit monotonic receipt times keep concurrent submissions/resets
// ordered; the actual five-minute clock remains the server submission time.
function receiptDate(previous: { createdAt: Date } | null, now: number) {
  return new Date(Math.max(now, previous ? previous.createdAt.getTime() + 1 : 0));
}

export async function recordCitizenReportSequence(
  tx: Prisma.TransactionClient, userId: string, report: Omit<CitizenReportReceipt, 'submittedAt'>,
): Promise<boolean> {
  const previous = await lastState(tx, userId);
  const reports = previous ? readCitizenReportSequence(previous.metadata) : [];
  const now = Date.now();
  const current = { ...report, submittedAt: now, services: [...report.services] };
  const violationServices = citizenReportViolation(reports, current);
  await tx.auditLog.create({ data: {
    actorId: userId, action: CITIZEN_REPORT_SEQUENCE_ACTION, entityType: 'User', entityId: userId,
    createdAt: receiptDate(previous, now), metadata: { version: 1, reports: [...reports, current].slice(-2) },
  } });
  if (violationServices.length === 0) return false;

  const changed = await tx.user.updateMany({ where: { id: userId, role: 'USER', status: 'ACTIVE' }, data: { status: 'INACTIVE' } });
  if (changed.count !== 1) throw new WorkflowConflict('Account permissions changed while reporting. Refresh and try again.');
  await tx.token.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(now) } });
  await tx.responder.updateMany({ where: { userId }, data: { status: 'OFF_DUTY' } });
  await tx.auditLog.create({ data: {
    actorId: userId, action: 'CITIZEN_AUTO_DEACTIVATED', entityType: 'User', entityId: userId,
    metadata: { reasonCode: CITIZEN_REPORT_LIMIT_CODE, threshold: 3, windowSeconds: CITIZEN_REPORT_WINDOW_MS / 1000,
      services: violationServices, incidentIds: [...reports, current].map(receipt => receipt.incidentId) },
  } });
  return true;
}

/** Main-admin-authorized reactivation/role changes start a new sequence. */
export async function resetCitizenReportSequence(
  tx: Prisma.TransactionClient, userId: string, actorId: string, reason: 'REACTIVATED' | 'ROLE_CHANGED',
) {
  const previous = await lastState(tx, userId);
  await tx.auditLog.create({ data: {
    actorId, action: CITIZEN_REPORT_SEQUENCE_ACTION, entityType: 'User', entityId: userId,
    createdAt: receiptDate(previous, Date.now()), metadata: { version: 1, reports: [], resetReason: reason },
  } });
}
