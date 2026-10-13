import { prisma } from '@/lib/prisma';
import type { JwtPayload } from '@/lib/jwt';
import { isMainAdministrator } from '@/domain/permissions.policy';
import { lockOperationalActor, OperationalAuthorizationError } from '@/lib/operational-actor';
import { requireConfirmedFalseReport, validFalseReportVersion, type FalseReportVersion } from '@/domain/false-report-disposition.policy';
import { WorkflowConflict, isWorkflowConflict } from '@/domain/workflow-error.policy';
import { publishEmergencyEvent } from '@/lib/events';

export async function CancelFalseIncidentService(id: string, input: FalseReportVersion & { reason: string }, actor: JwtPayload) {
  if (!isMainAdministrator(actor)) return { code: 403, status: 'error', message: 'Only the main administrator can cancel a confirmed false report.' };
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 10 || reason.length > 500 || !validFalseReportVersion(input))
    return { code: 400, status: 'error', message: 'A cancellation reason and current report/review versions are required.' };
  try {
    const result = await prisma.$transaction(async tx => {
      const fresh = await lockOperationalActor(tx, actor);
      if (!isMainAdministrator(fresh)) throw new OperationalAuthorizationError();
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${id}::uuid FOR UPDATE`;
      const current = await tx.incident.findUnique({ where: { incidentId: id }, include: { reviewFlags: true, incidentUnits: true, tasks: true, serviceResponses: true } });
      if (!current) return null;
      const retry = current.status === 'CANCELLED';
      const flag = requireConfirmedFalseReport(current, input, retry);
      if (retry) return { incidentId: id, status: current.status };
      if (current.status === 'CLOSED') throw new WorkflowConflict('This report is already closed. No cancellation is needed.');
      if (current.tasks.some(task => task.status !== 'DONE'))
        throw new WorkflowConflict('Complete outstanding incident tasks before cancellation. Department Resolve is not required.');
      await tx.incident.update({ where: { incidentId: id }, data: { status: 'CANCELLED' } });
      // Retain genuine completed response history. Unfinished response rows are
      // explicitly cancelled, not falsely marked RESOLVED by Main Admin.
      await tx.incidentServiceResponse.updateMany({ where: { incidentId: id, status: 'RESPONDING' }, data: { status: 'CANCELLED' } });
      await tx.auditLog.create({ data: { actorId: actor.sub, action: 'INCIDENT_CANCELLED_FALSE', entityType: 'Incident', entityId: id,
        metadata: { reason, previousStatus: current.status, reviewFlagId: flag.reviewFlagId, reviewUpdatedAt: flag.updatedAt.toISOString(), reviewNotes: flag.reviewNotes,
          previousResponses: current.serviceResponses.map(row => ({ service: row.service, status: row.status })),
          retiredUnitAssignments: current.incidentUnits.map(row => ({ unitId: row.unitId, status: row.status })) } } });
      return { incidentId: id, status: 'CANCELLED' as const };
    }, { timeout: 20000 });
    if (!result) return { code: 404, status: 'error', message: 'Incident not found' };
    publishEmergencyEvent({ type: 'incident.updated', entityId: id });
    return { code: 200, status: 'success', message: 'Confirmed false report cancelled. Record, evidence and audit history retained.', data: { incident: result } };
  } catch (error) {
    if (error instanceof OperationalAuthorizationError) return { code: error.code, status: 'error', message: error.message };
    if (isWorkflowConflict(error)) return { code: 409, status: 'error', message: error instanceof Error ? error.message : 'Report changed; refresh and retry.' };
    // Never echo request notes, provider errors or private row contents.
    return { code: 500, status: 'error', message: 'Cancellation could not be confirmed. Refresh before retrying.' };
  }
}
