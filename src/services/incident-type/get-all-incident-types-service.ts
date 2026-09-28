import { IncidentTypeRepository } from "@/repositories/incident-type.repository";

const incidentTypeRepository = new IncidentTypeRepository();

export const GetAllIncidentTypesService = async () => {
  try {
    const incidentTypes = await incidentTypeRepository.findAll();

    return {
      code: 200,
      status: "success",
      data: { incidentTypes },
    };
  } catch (error) {
    console.error("GetAllIncidentTypesService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch incident types" };
  }
};
