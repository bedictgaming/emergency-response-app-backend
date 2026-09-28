import { ResourceRepository } from "@/repositories/resource.repository";

const resourceRepository = new ResourceRepository();

export const GetResourceService = async (id: string) => {
  try {
    const resource = await resourceRepository.findById(id);

    if (!resource) {
      return { code: 404, status: "error", message: "Resource not found" };
    }

    return {
      code: 200,
      status: "success",
      data: { resource },
    };
  } catch (error) {
    console.error("GetResourceService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch resource" };
  }
};
