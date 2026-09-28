import { ResponderRepository } from "@/repositories/responder.repository";
import { Prisma, ResponderStatus } from "@/generated/prisma";

const responderRepository = new ResponderRepository();

interface GetAllRespondersFilters {
  unitId?: string;
  status?: ResponderStatus;
  unitScope?: Prisma.UnitWhereInput;
  userId?: string;
}

export const GetAllRespondersService = async (filters?: GetAllRespondersFilters) => {
  try {
    const responders = await responderRepository.findAll(filters);

    return {
      code: 200,
      status: "success",
      data: { responders },
    };
  } catch (error) {
    console.error("GetAllRespondersService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch responders" };
  }
};
