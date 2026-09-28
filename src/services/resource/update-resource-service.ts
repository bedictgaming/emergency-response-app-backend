import { ResourceRepository } from "@/repositories/resource.repository";
import { UpdateResourceInput } from "@/schema/resource/update-resource.schema";

const resourceRepository = new ResourceRepository();

export const UpdateResourceService = async (
  id: string,
  data: UpdateResourceInput
) => {
  try {
    const existing = await resourceRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Resource not found" };
    }

    // If unitId is changed, verify target unit exists
    if (data.unitId && data.unitId !== existing.unitId) {
      const unit = await resourceRepository.findUnitById(data.unitId);
      if (!unit) {
        return {
          code: 404,
          status: "error",
          message: "Unit not found. Please provide a valid unitId.",
        };
      }
    }

    const resource = await resourceRepository.update(id, data);

    return {
      code: 200,
      status: "success",
      message: "Resource updated successfully",
      data: { resource },
    };
  } catch (error) {
    console.error("UpdateResourceService Error", error);
    return { code: 500, status: "error", message: "Failed to update resource" };
  }
};
