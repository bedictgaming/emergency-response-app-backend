import { IncidentUnitRepository } from "@/repositories/incident-unit.repository";
import { UnitStatus } from "@/generated/prisma";
import { IncidentUnitStatus } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { publishEmergencyEvent } from "@/lib/events";

const incidentUnitRepository = new IncidentUnitRepository();

export const RemoveIncidentUnitService = async (id: string, actorId?: string) => {
  try {
    const existing = await incidentUnitRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Dispatch record not found" };
    }

    const unitId = existing.unit.unitId;
    const incidentId = existing.incident.incidentId;

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT unit_id FROM units WHERE unit_id = ${unitId}::uuid FOR UPDATE`;
      await tx.incidentUnit.delete({ where: { incidentUnitId: id } });
      const otherDispatches = await tx.incidentUnit.count({
        where: { unitId, status: { in: [IncidentUnitStatus.DISPATCHED, IncidentUnitStatus.EN_ROUTE, IncidentUnitStatus.ON_SCENE] } },
      });
      if (otherDispatches === 0) {
        await tx.unit.update({ where: { unitId }, data: { status: UnitStatus.AVAILABLE } });
      }
      await tx.auditLog.create({
        data: { actorId, action: "UNIT_UNASSIGNED", entityType: "IncidentUnit", entityId: id, metadata: { incidentId, unitId } },
      });
    });
    publishEmergencyEvent({ type: "dispatch.updated", entityId: id });

    return {
      code: 200,
      status: "success",
      message: `Unit "${existing.unit.unitName}" unassigned from incident`,
    };
  } catch (error) {
    console.error("RemoveIncidentUnitService Error", error);
    return {
      code: 500,
      status: "error",
      message: "Failed to remove unit from incident",
    };
  }
};

export const RemoveIncidentUnitByPairService = async (
  incidentId: string,
  unitId: string,
  actorId?: string,
) => {
  try {
    const existing = await incidentUnitRepository.findByIncidentAndUnit(
      incidentId,
      unitId
    );

    if (!existing) {
      return {
        code: 404,
        status: "error",
        message: "Unit is not currently assigned to this incident",
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT unit_id FROM units WHERE unit_id = ${unitId}::uuid FOR UPDATE`;
      await tx.incidentUnit.delete({ where: { incidentId_unitId: { incidentId, unitId } } });
      const otherDispatches = await tx.incidentUnit.count({
        where: { unitId, status: { in: [IncidentUnitStatus.DISPATCHED, IncidentUnitStatus.EN_ROUTE, IncidentUnitStatus.ON_SCENE] } },
      });
      if (otherDispatches === 0) {
        await tx.unit.update({ where: { unitId }, data: { status: UnitStatus.AVAILABLE } });
      }
      await tx.auditLog.create({
        data: { actorId, action: "UNIT_UNASSIGNED", entityType: "IncidentUnit", entityId: existing.incidentUnitId, metadata: { incidentId, unitId } },
      });
    });
    publishEmergencyEvent({ type: "dispatch.updated", entityId: existing.incidentUnitId });

    return {
      code: 200,
      status: "success",
      message: `Unit "${existing.unit.unitName}" unassigned from incident`,
    };
  } catch (error) {
    console.error("RemoveIncidentUnitByPairService Error", error);
    return {
      code: 500,
      status: "error",
      message: "Failed to remove unit from incident",
    };
  }
};
