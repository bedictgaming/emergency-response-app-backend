import { ResponseService, ServiceResponseStatus } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { departmentService } from "@/lib/department-access";
import type { JwtPayload } from "@/lib/jwt";
import { publishEmergencyEvent } from "@/lib/events";
import { isMainAdministrator } from "@/lib/permissions";
import { enqueueNotification } from '@/lib/jobs';
import { incidentNotificationAudience } from '@/lib/incident-notification-audience';

export async function UpdateServiceResponseService(incidentId: string, service: ResponseService, status: ServiceResponseStatus, actor: JwtPayload) {
  if (!["ADMIN", "DISPATCHER"].includes(actor.role)) return { code: 403, status: "error", message: "Operational role required" };
  if (isMainAdministrator(actor) && status === "RESOLVED") return { code: 403, status: "error", message: "Only the assigned department can resolve this response" };
  if (!isMainAdministrator(actor) && departmentService(actor.department) !== service) return { code: 403, status: "error", message: "You may only update your own department response" };
  try {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${incidentId}::uuid FOR UPDATE`;
      const incident = await tx.incident.findUnique({ where: { incidentId }, include: { serviceResponses: true } });
      if (!incident) return null;
      if (incident.status === "CLOSED" || incident.mergedIntoId) return "closed";
      const current = incident.serviceResponses.find(item => item.service === service);
      if (!current) return false;
      if (current.status === status) return current;
      const reopening = current.status === 'RESOLVED' && status === 'RESPONDING';
      const updated = await tx.incidentServiceResponse.update({ where: { incidentId_service: { incidentId, service } }, data: {
        status, resolvedAt: status === "RESOLVED" ? new Date() : null, resolvedBy: status === "RESOLVED" ? actor.sub : null,
        ...(reopening && { attentionVersion: { increment: 1 } }),
      } });
      const remaining = incident.serviceResponses.filter(item => item.service !== service && item.status !== "RESOLVED").length + (status === "RESOLVED" ? 0 : 1);
      const nextStatus = remaining === 0 ? "RESOLVED" : "RESPONDING";
      if (incident.status !== nextStatus || reopening) await tx.incident.update({ where: { incidentId }, data: { status: nextStatus, ...(reopening && { attentionVersion: { increment: 1 } }) } });
      await tx.auditLog.create({ data: { actorId: actor.sub, action: "SERVICE_RESPONSE_UPDATED", entityType: "Incident", entityId: incidentId, metadata: { service, status } } });
      if (reopening) await enqueueNotification(tx, 'INCIDENT_REOPENED', {
        title: 'Department response reopened', body: 'Open the dashboard to review current work.',
        data: { incidentId, responseService: service, attentionVersion: String(incident.attentionVersion + 1), serviceAttentionVersion: String(updated.attentionVersion) },
      }, await incidentNotificationAudience(tx, [service]));
      return updated;
    });
    if (result === null) return { code: 404, status: "error", message: "Incident not found" };
    if (result === "closed") return { code: 409, status: "error", message: "A closed or merged report cannot change its department response" };
    if (result === false) return { code: 409, status: "error", message: "That service was not requested for this incident" };
    publishEmergencyEvent({ type: "incident.updated", entityId: incidentId });
    return { code: 200, status: "success", message: "Department response updated", data: { serviceResponse: result } };
  } catch (error) {
    console.error("UpdateServiceResponseService Error", error);
    return { code: 409, status: "error", message: "The response changed concurrently. Refresh and retry." };
  }
}
