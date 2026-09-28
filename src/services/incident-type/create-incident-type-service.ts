import { IncidentTypeRepository } from "@/repositories/incident-type.repository";
import { CreateIncidentTypeInput } from "@/schema/incident-type/create-incident-type.schema";

const incidentTypeRepository = new IncidentTypeRepository();

export const CreateIncidentTypeService = async (data: CreateIncidentTypeInput) => {
  try {
    // Enforce unique typeName at service layer
    const existing = await incidentTypeRepository.findByName(data.typeName);
    if (existing) {
      return {
        code: 409,
        status: "error",
        message: `Incident type "${data.typeName}" already exists`,
      };
    }

    const incidentType = await incidentTypeRepository.create(data);

    return {
      code: 201,
      status: "success",
      message: "Incident type created successfully",
      data: { incidentType },
    };
  } catch (error) {
    console.error("CreateIncidentTypeService Error", error);
    return { code: 500, status: "error", message: "Failed to create incident type" };
  }
};
