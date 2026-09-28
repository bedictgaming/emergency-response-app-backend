import { UnitRepository } from "@/repositories/unit.repository";

const unitRepository = new UnitRepository();

export const DeleteUnitService = async (id: string) => {
  try {
    const existing = await unitRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Unit not found" };
    }

    // Block deletion if the unit is currently deployed on an active/open incident
    const isDeployed = await unitRepository.hasActiveDeployments(id);
    if (isDeployed) {
      return {
        code: 409,
        status: "error",
        message:
          "Cannot delete unit — it is currently deployed on one or more active incidents. Resolve or unassign the incidents first.",
      };
    }
    if (existing._count.responders || existing._count.resources || existing._count.incidentUnits) {
      return {
        code: 409,
        status: "error",
        message: "Cannot delete unit while responders, resources, or dispatch history are linked to it. Reassign those records first.",
      };
    }

    await unitRepository.delete(id);

    return {
      code: 200,
      status: "success",
      message: "Unit deleted successfully",
    };
  } catch (error) {
    console.error("DeleteUnitService Error", error);
    return { code: 500, status: "error", message: "Failed to delete unit" };
  }
};
