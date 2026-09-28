import { ResponseService, ServiceResponseStatus } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { departmentService } from "@/lib/department-access";
import type { JwtPayload } from "@/lib/jwt";
import { publishEmergencyEvent } from "@/lib/events";
import { isMainAdministrator } from "@/lib/permissions";

export async function UpdateServiceResponseService(incidentId: string, service: ResponseService, status: ServiceResponseStatus, actor: JwtPayload) {
  if (!["ADMIN", "DISPATCHER"].includes(actor.role)) return { code: 403, status: "error", message: "Operational role required" };
  if (!isMainAdministrator(actor) && departmentService(actor.department) !== service) return { code: 403, status: "error", message: "You may only update your own department response" };
  try {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${incidentId}::uuid FOR UPDATE`;
      const incident = await tx.incident.findUnique({ where: { incidentId }, include: { serviceResponses: true } });
      if (!incident) return null;
      if (incident.status === "CLOSED" || incident.mergedIntoId) return "closed";
      const current = incident.serviceResponses.find(item => item.service === service);
      if (!current) return false;
      const updated = await tx.incidentServiceResponse.update({ where: { incidentId_service: { incidentId, service } }, data: {
        status, resolvedAt: status === "RESOLVED" ? new Date() : null, resolvedBy: status === "RESOLVED" ? actor.sub : null,
      } });
      const remaining = incident.serviceResponses.filter(item => item.service !== service && item.status !== "RESOLVED").length + (status === "RESOLVED" ? 0 : 1);
      const nextStatus = remaining === 0 ? "RESOLVED" : "RESPONDING";
      if (incident.status !== nextStatus) await tx.incident.update({ where: { incidentId }, data: { status: nextStatus } });
      await tx.auditLog.create({ data: { actorId: actor.sub, action: "SERVICE_RESPONSE_UPDATED", entityType: "Incident", entityId: incidentId, metadata: { service, status } } });
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
