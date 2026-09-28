import { prisma } from "@/lib/prisma";
import { departmentIncidentScope } from "@/lib/department-access";
import type { JwtPayload } from "@/lib/jwt";
import { publishEmergencyEvent } from "@/lib/events";
import { WorkflowConflict, isWorkflowConflict } from "@/lib/workflow-error";
import { responseServicesForIncident, sameResponseServices } from "@/lib/response-services";
import { protectIncidentEvidence } from "@/lib/evidence";

export async function MergeIncidentService(sourceIncidentId: string, targetIncidentId: string, reason: string, actor: JwtPayload) {
  if (!["ADMIN", "DISPATCHER"].includes(actor.role)) return { code: 403, status: "error", message: "Operational role required" };
  if (sourceIncidentId === targetIncidentId) return { code: 400, status: "error", message: "An incident cannot be merged into itself" };
  try {
    const source = await prisma.$transaction(async (tx) => {
      for (const id of [sourceIncidentId, targetIncidentId].sort()) {
        await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${id}::uuid FOR UPDATE`;
      }
      const incidents = await tx.incident.findMany({
        where: { incidentId: { in: [sourceIncidentId, targetIncidentId] }, ...departmentIncidentScope(actor) },
        select: {
          incidentId: true, status: true, mergedIntoId: true, requestedServices: true,
          type: { select: { typeName: true } },
        },
      });
      if (incidents.length !== 2) return null;
      const currentSource = incidents.find(({ incidentId }) => incidentId === sourceIncidentId)!;
      const target = incidents.find(({ incidentId }) => incidentId === targetIncidentId)!;
      if (currentSource.mergedIntoId) throw new WorkflowConflict("The source incident was already merged");
      if (["CLOSED", "RESOLVED"].includes(currentSource.status)) throw new WorkflowConflict("The source incident is no longer active");
      if (["CLOSED", "RESOLVED"].includes(target.status)) throw new WorkflowConflict("The target incident is no longer active");
      const sourceServices = responseServicesForIncident(currentSource);
      const targetServices = responseServicesForIncident(target);
      if (!sourceServices.length || !sameResponseServices(sourceServices, targetServices)) {
        throw new WorkflowConflict("Reports with different response services cannot be merged");
      }
      const [activeTasks, activeDispatches] = await Promise.all([
        tx.task.count({ where: { incidentId: sourceIncidentId, status: { not: "DONE" } } }),
        tx.incidentUnit.count({ where: { incidentId: sourceIncidentId, status: { not: "RETURNED" } } }),
      ]);
      if (activeTasks || activeDispatches) {
        throw new WorkflowConflict("Complete or reassign active tasks and dispatches before merging this report");
      }
      const mergedAt = new Date();
      const updated = await tx.incident.update({ where: { incidentId: sourceIncidentId }, data: {
        status: "CLOSED", mergedIntoId: targetIncidentId, mergedAt, mergedBy: actor.sub, mergeReason: reason,
      } });
      await tx.incidentServiceResponse.updateMany({
        where: { incidentId: sourceIncidentId, status: { not: "RESOLVED" } },
        data: { status: "RESOLVED", resolvedAt: mergedAt, resolvedBy: actor.sub },
      });
      await tx.auditLog.create({ data: {
        actorId: actor.sub, action: "INCIDENT_MERGED", entityType: "Incident", entityId: sourceIncidentId,
        metadata: { targetIncidentId, reason, supersededServices: sourceServices },
      } });
      return updated;
    });
    if (!source) return { code: 404, status: "error", message: "Both incidents must exist in your department" };
    publishEmergencyEvent({ type: "incident.updated", entityId: sourceIncidentId });
    publishEmergencyEvent({ type: "incident.updated", entityId: targetIncidentId });
    return { code: 200, status: "success", message: "Related report merged", data: { incident: protectIncidentEvidence(source) } };
  } catch (error) {
    if (isWorkflowConflict(error)) return { code: 409, status: "error", message: error instanceof Error ? error.message : "Incident changed concurrently" };
    console.error("MergeIncidentService Error", error);
    return { code: 500, status: "error", message: "Failed to merge incidents" };
  }
}
