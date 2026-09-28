import { IncidentTypeRepository } from "@/repositories/incident-type.repository";

const incidentTypeRepository = new IncidentTypeRepository();

export const DeleteIncidentTypeService = async (id: string) => {
  try {
    const existing = await incidentTypeRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Incident type not found" };
    }

    // Prevent deletion if incidents are currently linked to this type
    const hasLinked = await incidentTypeRepository.hasLinkedIncidents(id);
    if (hasLinked) {
      return {
        code: 409,
        status: "error",
        message:
          "Cannot delete incident type — one or more incidents are still linked to it. Reassign or resolve those incidents first.",
      };
    }

    await incidentTypeRepository.delete(id);

    return {
      code: 200,
      status: "success",
      message: "Incident type deleted successfully",
    };
  } catch (error) {
    console.error("DeleteIncidentTypeService Error", error);
    return { code: 500, status: "error", message: "Failed to delete incident type" };
  }
};
