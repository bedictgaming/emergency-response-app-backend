import { ResourceRepository } from "@/repositories/resource.repository";
import { Prisma, ResourceStatus } from "@/generated/prisma";

const resourceRepository = new ResourceRepository();

interface GetAllResourcesFilters {
  unitId?: string;
  status?: ResourceStatus;
  resourceType?: string;
  unitScope?: Prisma.UnitWhereInput;
  responderUserId?: string;
}

export const GetAllResourcesService = async (filters?: GetAllResourcesFilters) => {
  try {
    const resources = await resourceRepository.findAll(filters);

    return {
      code: 200,
      status: "success",
      data: { resources },
    };
  } catch (error) {
    console.error("GetAllResourcesService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch resources" };
  }
};
