import { prisma } from '@/lib/prisma';
import { departmentService } from '@/lib/department-access';
import { isMainAdministrator } from '@/lib/permissions';
import { responseServicesForIncident, unitTypeSupportsService } from '@/lib/response-services';

export type NotificationJob = { eventType: string; createdAt: Date; payload: unknown; userIds: string[]; audienceIds?: string[] };
export const notificationAudience = (job: NotificationJob) => job.audienceIds ?? job.userIds;
export function notificationExpiry(job: Pick<NotificationJob, 'eventType' | 'createdAt'>) {
  const lifetime = job.eventType === 'INCIDENT_VERIFIED' ? 24 * 60 * 60_000 : job.eventType === 'ALERT_CREATED' ? 60 * 60_000 : 15 * 60_000;
  return new Date(job.createdAt.getTime() + lifetime);
}

// Failure to read current state throws and preserves retryable work; it is not
// interpreted as resolution. Push is a hint, never dispatch authority.
export async function notificationRelevant(job: NotificationJob, userId: string) {
  if (!notificationAudience(job).includes(userId) || notificationExpiry(job).getTime() <= Date.now()) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: {
    role: true, status: true, department: true, isMainAdmin: true,
    responder: { select: { responderId: true, status: true, unit: { select: { unitType: true } } } },
  } });
  if (!user || user.status !== 'ACTIVE' || !['USER', 'ADMIN', 'DISPATCHER'].includes(user.role)) return false;
  const data = (job.payload as { data?: Record<string, string> })?.data ?? {};
  if (job.eventType === 'ALERT_CREATED') return Boolean(data.alertId && await prisma.alert.findUnique({ where: { alertId: data.alertId }, select: { alertId: true } }));
  if (!data.incidentId) return false;
  const incident = await prisma.incident.findUnique({ where: { incidentId: data.incidentId }, include: { type: true, serviceResponses: true } });
  if (!incident) return false;
  if (job.eventType === 'INCIDENT_VERIFIED') return incident.reportedBy === userId;
  if (incident.verificationStatus !== 'VERIFIED' || incident.mergedIntoId || !['OPEN','ACTIVE','RESPONDING'].includes(incident.status)) return false;
  const services = responseServicesForIncident(incident);
  const outstandingServices = services.filter(service => incident.serviceResponses.find(item => item.service === service)?.status !== 'RESOLVED');
  if (user.role === 'RESPONDER' && (!user.responder || !unitTypeSupportsService(user.responder.unit.unitType, outstandingServices))) return false;
  if (job.eventType === 'TASK_CREATED') return Boolean(data.taskId && user.role === 'RESPONDER' && await prisma.task.findFirst({ where: { taskId: data.taskId, incidentId: incident.incidentId, status: { not: 'DONE' }, assignee: { userId } }, select: { taskId: true } }));
  if (job.eventType === 'UNIT_DISPATCHED') return Boolean(data.dispatchId && user.role === 'RESPONDER' && await prisma.incidentUnit.findFirst({ where: { incidentUnitId: data.dispatchId, incidentId: incident.incidentId, status: { not: 'RETURNED' }, unit: { responders: { some: { userId } } } }, select: { incidentUnitId: true } }));
  if (!['INCIDENT_CREATED', 'INCIDENT_REOPENED'].includes(job.eventType)) return false;
  const requestedVersion = Number(data.attentionVersion ?? '1');
  const serviceVersion = Number(data.serviceAttentionVersion ?? '1');
  if (!Number.isSafeInteger(requestedVersion) || !Number.isSafeInteger(serviceVersion)) return false;
  if (isMainAdministrator(user)) {
    if (requestedVersion !== incident.attentionVersion) return false;
    const acknowledged = await prisma.incidentAcknowledgement.findUnique({ where: { userId_incidentId_scope: { userId, incidentId: incident.incidentId, scope: 'MAIN' } }, select: { version: true } });
    return acknowledged?.version !== requestedVersion;
  }
  const service = departmentService(user.department);
  if (['ADMIN','DISPATCHER'].includes(user.role)) {
    if (!service || !services.includes(service) || (data.responseService && data.responseService !== service)
      || (incident.serviceResponses.find(item => item.service === service)?.attentionVersion ?? incident.attentionVersion) !== serviceVersion
      || incident.serviceResponses.find(item => item.service === service)?.status === 'RESOLVED') return false;
    const acknowledged = await prisma.incidentAcknowledgement.findUnique({ where: { userId_incidentId_scope: { userId, incidentId: incident.incidentId, scope: service } }, select: { version: true } });
    return acknowledged?.version !== serviceVersion;
  }
  return user.role === 'RESPONDER' && !!user.responder && user.responder.status !== 'OFF_DUTY'
    && unitTypeSupportsService(user.responder.unit.unitType, services.filter(item => (!data.responseService || data.responseService === item)
      && (incident.serviceResponses.find(response => response.service === item)?.attentionVersion ?? incident.attentionVersion) === serviceVersion
      && incident.serviceResponses.find(response => response.service === item)?.status !== 'RESOLVED'));
}
