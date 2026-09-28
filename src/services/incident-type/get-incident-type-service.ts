import { IncidentTypeRepository } from "@/repositories/incident-type.repository";

const incidentTypeRepository = new IncidentTypeRepository();

export const GetIncidentTypeService = async (id: string) => {
  try {
    const incidentType = await incidentTypeRepository.findById(id);

    if (!incidentType) {
      return { code: 404, status: "error", message: "Incident type not found" };
    }

    return {
      code: 200,
      status: "success",
      data: { incidentType },
    };
  } catch (error) {
    console.error("GetIncidentTypeService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch incident type" };
  }
};
