import { prisma } from '@/lib/prisma';
import type { JwtPayload } from '@/lib/jwt';
import type { EmergencyEvent } from '@/lib/events';
import { departmentDispatchScope, departmentIncidentScope, departmentTaskScope } from '@/lib/department-access';
import { isMainAdministrator } from '@/lib/permissions';

export async function canReceiveEvent(actor: JwtPayload, event: EmergencyEvent) {
  if (event.type === 'alert.created') return true;
  if (['ADMIN', 'DISPATCHER'].includes(actor.role)) {
    if (isMainAdministrator(actor)) return true;
    if (event.type.startsWith('incident.')) return !!await prisma.incident.findFirst({ where: { incidentId: event.entityId, ...departmentIncidentScope(actor) }, select: { incidentId: true } });
    if (event.type === 'dispatch.updated') return !!await prisma.incidentUnit.findFirst({ where: { incidentUnitId: event.entityId, ...departmentDispatchScope(actor) }, select: { incidentUnitId: true } });
    if (event.type === 'task.updated') return !!await prisma.task.findFirst({ where: { taskId: event.entityId, ...departmentTaskScope(actor) }, select: { taskId: true } });
    return false;
  }
  if (actor.role === 'USER' && event.type.startsWith('incident.')) {
    return !!await prisma.incident.findFirst({ where: { incidentId: event.entityId, reportedBy: actor.sub }, select: { incidentId: true } });
  }
  if (actor.role === 'RESPONDER' && event.type === 'task.updated') {
    return !!await prisma.task.findFirst({ where: { taskId: event.entityId, assignee: { userId: actor.sub } }, select: { taskId: true } });
  }
  if (actor.role === 'RESPONDER' && event.type === 'dispatch.updated') {
    return !!await prisma.incidentUnit.findFirst({ where: { incidentUnitId: event.entityId, unit: { responders: { some: { userId: actor.sub } } } }, select: { incidentUnitId: true } });
  }
  return false;
}
