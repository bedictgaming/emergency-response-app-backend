import { UnitRepository } from "@/repositories/unit.repository";
import { Prisma, UnitStatus } from "@/generated/prisma";

const unitRepository = new UnitRepository();

interface GetAllUnitsFilters {
  status?: UnitStatus;
  unitType?: string;
  scope?: Prisma.UnitWhereInput;
  responderUserId?: string;
}

export const GetAllUnitsService = async (filters?: GetAllUnitsFilters) => {
  try {
    const units = await unitRepository.findAll(filters);

    return {
      code: 200,
      status: "success",
      data: { units },
    };
  } catch (error) {
    console.error("GetAllUnitsService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch units" };
  }
};
