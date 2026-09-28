import { IncidentRepository } from "@/repositories/incident.repository";
import { prisma } from "@/lib/prisma";
import { enqueueAssetCleanup } from "@/lib/jobs";
import { UnitStatus } from "@/generated/prisma";
import { WorkflowConflict, isWorkflowConflict } from "@/lib/workflow-error";

const incidentRepository = new IncidentRepository();
export const DeleteIncidentService = async (id: string, userId?: string, userRole?: string) => {
  try {
    if (userRole !== "ADMIN") {
      return { code: 403, status: "error", message: "Only a system administrator can permanently delete an incident" };
    }
    const existing = await incidentRepository.findById(id);
    if (!existing) return { code: 404, status: "error", message: "Incident not found" };
    if (existing.status !== "CLOSED") {
      return { code: 409, status: "error", message: "Close the incident before permanently deleting it" };
    }

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${id}::uuid FOR UPDATE`;
      const current = await tx.incident.findUnique({
        where: { incidentId: id },
        include: { attachments: { select: { publicId: true } }, incidentUnits: { select: { unitId: true } } },
      });
      if (!current) throw new WorkflowConflict("Incident was already removed");
      if (current.status !== "CLOSED") throw new WorkflowConflict("Incident status changed; close it before deletion");

      for (const attachment of current.attachments) {
        if (attachment.publicId) await enqueueAssetCleanup(tx, attachment.publicId);
      }

      const unitIds = [...new Set(current.incidentUnits.map(item => item.unitId))];
      await tx.alert.updateMany({ where: { incidentId: id }, data: { incidentId: null } });
      await tx.task.deleteMany({ where: { incidentId: id } });
      await tx.incidentUnit.deleteMany({ where: { incidentId: id } });
      await tx.attachment.deleteMany({ where: { incidentId: id } });
      await tx.incident.delete({ where: { incidentId: id } });
      for (const unitId of unitIds) {
        const active = await tx.incidentUnit.count({ where: { unitId, status: { not: "RETURNED" } } });
        if (!active) await tx.unit.updateMany({ where: { unitId, status: UnitStatus.DEPLOYED }, data: { status: UnitStatus.AVAILABLE } });
      }
      await tx.auditLog.create({ data: {
        actorId: userId, action: "INCIDENT_DELETED", entityType: "Incident", entityId: id,
        metadata: { title: current.title, status: current.status, attachmentCount: current.attachments.length },
      } });
    }, { timeout: 20_000 });

    return { code: 200, status: "success", message: "Incident deleted successfully" };
  } catch (error) {
    if (isWorkflowConflict(error)) {
      return { code: 409, status: "error", message: error instanceof Error ? error.message : "Incident changed concurrently" };
    }
    console.error("DeleteIncidentService Error", error);
    return { code: 500, status: "error", message: "Failed to delete incident" };
  }
};
