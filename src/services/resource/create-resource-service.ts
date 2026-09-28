import { ResourceRepository } from "@/repositories/resource.repository";
import { CreateResourceInput } from "@/schema/resource/create-resource.schema";

const resourceRepository = new ResourceRepository();

export const CreateResourceService = async (data: CreateResourceInput) => {
  try {
    // Verify target unit exists
    const unit = await resourceRepository.findUnitById(data.unitId);
    if (!unit) {
      return {
        code: 404,
        status: "error",
        message: "Unit not found. Please provide a valid unitId.",
      };
    }

    const resource = await resourceRepository.create(data);

    return {
      code: 201,
      status: "success",
      message: "Resource registered successfully",
      data: { resource },
    };
  } catch (error) {
    console.error("CreateResourceService Error", error);
    return { code: 500, status: "error", message: "Failed to create resource" };
  }
};
