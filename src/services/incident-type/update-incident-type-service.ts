import { IncidentTypeRepository } from "@/repositories/incident-type.repository";
import { UpdateIncidentTypeInput } from "@/schema/incident-type/update-incident-type.schema";

const incidentTypeRepository = new IncidentTypeRepository();

export const UpdateIncidentTypeService = async (id: string, data: UpdateIncidentTypeInput) => {
  try {
    const existing = await incidentTypeRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Incident type not found" };
    }

    // If typeName is being changed, check it does not clash with another record
    if (data.typeName && data.typeName !== existing.typeName) {
      const nameConflict = await incidentTypeRepository.findByName(data.typeName);
      if (nameConflict) {
        return {
          code: 409,
          status: "error",
          message: `Incident type "${data.typeName}" already exists`,
        };
      }
    }

    const incidentType = await incidentTypeRepository.update(id, data);

    return {
      code: 200,
      status: "success",
      message: "Incident type updated successfully",
      data: { incidentType },
    };
  } catch (error) {
    console.error("UpdateIncidentTypeService Error", error);
    return { code: 500, status: "error", message: "Failed to update incident type" };
  }
};
