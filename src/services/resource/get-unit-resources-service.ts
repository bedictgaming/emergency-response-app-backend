import { ResourceRepository } from "@/repositories/resource.repository";

const resourceRepository = new ResourceRepository();

export const GetUnitResourcesService = async (unitId: string) => {
  try {
    const unit = await resourceRepository.findUnitById(unitId);
    if (!unit) {
      return { code: 404, status: "error", message: "Unit not found" };
    }

    const resources = await resourceRepository.findByUnitId(unitId);

    return {
      code: 200,
      status: "success",
      data: { unit, resources },
    };
  } catch (error) {
    console.error("GetUnitResourcesService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch unit resources" };
  }
};
