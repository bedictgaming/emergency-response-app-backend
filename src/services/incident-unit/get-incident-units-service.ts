import { IncidentUnitRepository } from "@/repositories/incident-unit.repository";
import { IncidentUnitStatus, Prisma } from "@/generated/prisma";

const incidentUnitRepository = new IncidentUnitRepository();

interface GetIncidentUnitsFilters {
  incidentId?: string;
  unitId?: string;
  status?: IncidentUnitStatus;
  assignedUserId?: string;
  dispatchScope?: Prisma.IncidentUnitWhereInput;
}

export const GetIncidentUnitsService = async (filters?: GetIncidentUnitsFilters, requesterId?: string, requesterRole?: string) => {
  try {
    const incidentUnits = await incidentUnitRepository.findAll({
      ...filters,
      ...(requesterRole === "RESPONDER" && requesterId ? { assignedUserId: requesterId } : {}),
    });

    return {
      code: 200,
      status: "success",
      data: { incidentUnits },
    };
  } catch (error) {
    console.error("GetIncidentUnitsService Error", error);
    return {
      code: 500,
      status: "error",
      message: "Failed to fetch dispatched units",
    };
  }
};
