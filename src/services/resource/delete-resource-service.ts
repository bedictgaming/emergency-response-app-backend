import { ResourceRepository } from "@/repositories/resource.repository";

const resourceRepository = new ResourceRepository();

export const DeleteResourceService = async (id: string) => {
  try {
    const existing = await resourceRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Resource not found" };
    }

    await resourceRepository.delete(id);

    return {
      code: 200,
      status: "success",
      message: "Resource deleted successfully",
    };
  } catch (error) {
    console.error("DeleteResourceService Error", error);
    return { code: 500, status: "error", message: "Failed to delete resource" };
  }
};
