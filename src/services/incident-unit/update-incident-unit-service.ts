import { IncidentUnitRepository } from "@/repositories/incident-unit.repository";
import { UpdateIncidentUnitInput } from "@/schema/incident-unit/update-incident-unit.schema";
import { IncidentUnitStatus, UnitStatus } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { publishEmergencyEvent } from "@/lib/events";
import { WorkflowConflict, isWorkflowConflict } from "@/lib/workflow-error";

const incidentUnitRepository = new IncidentUnitRepository();

// Valid dispatch status transitions
const VALID_DISPATCH_TRANSITIONS: Record<string, string[]> = {
  DISPATCHED: ["EN_ROUTE", "ON_SCENE", "RETURNED"],
  EN_ROUTE: ["ON_SCENE", "RETURNED"],
  ON_SCENE: ["RETURNED"],
  RETURNED: [],
};

export const UpdateIncidentUnitService = async (
  id: string,
  data: UpdateIncidentUnitInput,
  actorId?: string,
  actorRole?: string,
) => {
  try {
    const existing = await incidentUnitRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Dispatch record not found" };
    }
    if (actorRole === "RESPONDER") {
      const member = existing.unit.responders.some((responder) => responder.user.id === actorId);
      if (!member || Object.keys(data).some((key) => key !== "status")) {
        return { code: 403, status: "error", message: "Responders may only update status for their assigned unit" };
      }
    } else if (!["ADMIN", "DISPATCHER"].includes(actorRole ?? "")) {
      return { code: 403, status: "error", message: "Operational role required" };
    }

    // Validate status transition if status is being modified
    if (data.status && data.status !== existing.status) {
      const allowedNext = VALID_DISPATCH_TRANSITIONS[existing.status] ?? [];
      if (!allowedNext.includes(data.status)) {
        return {
          code: 400,
          status: "error",
          message: `Invalid dispatch transition: cannot move from "${existing.status}" to "${data.status}". Allowed: ${allowedNext.join(", ") || "none"}`,
        };
      }
    }

    const incidentUnit = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT unit_id FROM units WHERE unit_id = ${existing.unit.unitId}::uuid FOR UPDATE`;
      if (actorRole === "RESPONDER" && !await tx.responder.findFirst({ where: { userId: actorId, unitId: existing.unit.unitId } })) throw new WorkflowConflict("Unit assignment changed. Refresh and retry.");
      const updated = await tx.incidentUnit.update({
        where: { incidentUnitId: id, status: existing.status },
        data: {
          ...(data.role !== undefined && { role: data.role }),
          ...(data.status && { status: data.status }),
        },
        include: { unit: true, incident: true },
      });

      if (data.status === IncidentUnitStatus.RETURNED) {
        const activeDispatches = await tx.incidentUnit.count({
          where: {
            unitId: existing.unit.unitId,
            status: { in: [IncidentUnitStatus.DISPATCHED, IncidentUnitStatus.EN_ROUTE, IncidentUnitStatus.ON_SCENE] },
          },
        });
        if (activeDispatches === 0) {
          await tx.unit.update({ where: { unitId: existing.unit.unitId }, data: { status: UnitStatus.AVAILABLE } });
        }
      }

      await tx.auditLog.create({
        data: {
          actorId,
          action: "DISPATCH_UPDATED",
          entityType: "IncidentUnit",
          entityId: id,
          metadata: { previousStatus: existing.status, nextStatus: data.status, role: data.role },
        },
      });
      return updated;
    });
    publishEmergencyEvent({ type: "dispatch.updated", entityId: id });

    return {
      code: 200,
      status: "success",
      message: "Dispatch status updated successfully",
      data: { incidentUnit },
    };
  } catch (error) {
    if (isWorkflowConflict(error)) return { code: 409, status: "error", message: "Dispatch or assignment changed concurrently. Refresh and retry." };
    console.error("UpdateIncidentUnitService Error", error);
    return {
      code: 500,
      status: "error",
      message: "Failed to update dispatch record",
    };
  }
};
