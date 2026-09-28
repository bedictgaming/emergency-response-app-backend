import { IncidentUnitRepository } from "@/repositories/incident-unit.repository";
import { DispatchUnitInput } from "@/schema/incident-unit/dispatch-unit.schema";
import { IncidentUnitStatus, UnitStatus } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { publishEmergencyEvent } from "@/lib/events";
import { enqueueNotification } from "@/lib/jobs";
import { WorkflowConflict, isWorkflowConflict } from "@/lib/workflow-error";
import type { JwtPayload } from "@/lib/jwt";
import { departmentService } from "@/lib/department-access";
import { unitTypeSupportsService } from "@/lib/response-services";
import { isMainAdministrator } from "@/lib/permissions";

const incidentUnitRepository = new IncidentUnitRepository();

export const DispatchUnitService = async (
  incidentId: string,
  data: DispatchUnitInput,
  actor: JwtPayload,
) => {
  try {
    if (data.status && data.status !== IncidentUnitStatus.DISPATCHED) return { code: 400, status: "error", message: "New dispatches must start as DISPATCHED" };
    // 1. Verify incident exists
    const incident = await incidentUnitRepository.findIncidentById(incidentId);
    if (!incident) {
      return { code: 404, status: "error", message: "Incident not found" };
    }

    // 2. Cannot dispatch units to a CLOSED or RESOLVED incident
    if (incident.status === "CLOSED" || incident.status === "RESOLVED") {
      return {
        code: 400,
        status: "error",
        message: `Cannot dispatch units to an incident that is ${incident.status}`,
      };
    }

    if (incident.verificationStatus !== "VERIFIED") {
      return { code: 409, status: "error", message: "Units can only be dispatched to verified incidents" };
    }

    // 3. Verify unit exists
    const unit = await incidentUnitRepository.findUnitById(data.unitId);
    if (!unit) {
      return {
        code: 404,
        status: "error",
        message: "Unit not found. Please provide a valid unitId.",
      };
    }

    const actorService = departmentService(actor.department);
    if (!isMainAdministrator(actor)
      && (!actorService || !unitTypeSupportsService(unit.unitType, [actorService]))) {
      return { code: 403, status: "error", message: "You can only dispatch units from your own department" };
    }

    // 4. Cannot dispatch a unit that is OUT_OF_SERVICE
    if (unit.status === UnitStatus.OUT_OF_SERVICE) {
      return {
        code: 400,
        status: "error",
        message: "Cannot dispatch a unit that is OUT_OF_SERVICE",
      };
    }

    // 5. Check if already dispatched to this incident
    const existingDispatch =
      await incidentUnitRepository.findByIncidentAndUnit(
        incidentId,
        data.unitId
      );
    if (existingDispatch) {
      return {
        code: 409,
        status: "error",
        message: `Unit "${unit.unitName}" is already assigned to this incident (Status: ${existingDispatch.status})`,
      };
    }

    // 6. Create dispatch and reserve the unit atomically.
    const incidentUnit = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${incidentId}::uuid FOR UPDATE`;
      const current = await tx.incident.findUniqueOrThrow({ where: { incidentId } });
      if (current.verificationStatus !== "VERIFIED" || ["RESOLVED", "CLOSED"].includes(current.status)) throw new WorkflowConflict("Incident is no longer dispatchable");
      const reserved = await tx.unit.updateMany({ where: { unitId: data.unitId, status: UnitStatus.AVAILABLE }, data: { status: UnitStatus.DEPLOYED } });
      if (reserved.count !== 1) throw new WorkflowConflict("This unit is no longer available");
      const created = await tx.incidentUnit.create({
        data: {
          incidentId,
          unitId: data.unitId,
          role: data.role,
          status: data.status ?? IncidentUnitStatus.DISPATCHED,
        },
        include: { incident: true, unit: true },
      });
      await tx.auditLog.create({
        data: { actorId: actor.sub, action: "UNIT_DISPATCHED", entityType: "IncidentUnit", entityId: created.incidentUnitId, metadata: { incidentId, unitId: data.unitId } },
      });
      const assignedUsers = await tx.responder.findMany({ where: { unitId: data.unitId }, select: { userId: true } });
      await enqueueNotification(tx, "UNIT_DISPATCHED", {
        title: "Unit dispatched",
        body: `${unit.unitName} was dispatched to ${incident.title}`,
        data: { incidentId, dispatchId: created.incidentUnitId, type: "dispatch" },
      }, assignedUsers.map((responder) => responder.userId));
      return created;
    });
    publishEmergencyEvent({ type: "dispatch.updated", entityId: incidentUnit.incidentUnitId });
    return {
      code: 201,
      status: "success",
      message: `Unit "${unit.unitName}" successfully dispatched to incident`,
      data: { incidentUnit },
    };
  } catch (error) {
    if (isWorkflowConflict(error)) return { code: 409, status: "error", message: error instanceof WorkflowConflict ? error.message : "Dispatch changed concurrently. Refresh and retry." };
    console.error("DispatchUnitService Error", error);
    return {
      code: 500,
      status: "error",
      message: "Failed to dispatch unit to incident",
    };
  }
};
