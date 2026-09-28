import { UnitRepository } from "@/repositories/unit.repository";

const unitRepository = new UnitRepository();

export const GetUnitService = async (id: string) => {
  try {
    const unit = await unitRepository.findById(id);

    if (!unit) {
      return { code: 404, status: "error", message: "Unit not found" };
    }

    return {
      code: 200,
      status: "success",
      data: { unit },
    };
  } catch (error) {
    console.error("GetUnitService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch unit" };
  }
};
