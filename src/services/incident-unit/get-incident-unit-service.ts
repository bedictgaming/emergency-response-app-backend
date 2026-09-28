import { IncidentUnitRepository } from "@/repositories/incident-unit.repository";

const incidentUnitRepository = new IncidentUnitRepository();

export const GetIncidentUnitService = async (id: string, requesterId?: string, requesterRole?: string) => {
  try {
    const incidentUnit = await incidentUnitRepository.findById(id);

    if (!incidentUnit) {
      return { code: 404, status: "error", message: "Dispatch record not found" };
    }
    if (requesterRole === "RESPONDER" && !incidentUnit.unit.responders.some(item => item.user.id === requesterId)) {
      return { code: 403, status: "error", message: "Dispatch record is outside your assigned unit" };
    }

    return {
      code: 200,
      status: "success",
      data: { incidentUnit },
    };
  } catch (error) {
    console.error("GetIncidentUnitService Error", error);
    return {
      code: 500,
      status: "error",
      message: "Failed to fetch dispatch record",
    };
  }
};
