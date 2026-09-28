import { UnitRepository } from "@/repositories/unit.repository";
import { CreateUnitInput } from "@/schema/unit/create-unit.schema";

const unitRepository = new UnitRepository();

export const CreateUnitService = async (data: CreateUnitInput) => {
  try {
    // Enforce unique unitName at service layer
    const existing = await unitRepository.findByName(data.unitName);
    if (existing) {
      return {
        code: 409,
        status: "error",
        message: `A unit named "${data.unitName}" already exists`,
      };
    }

    const unit = await unitRepository.create(data);

    return {
      code: 201,
      status: "success",
      message: "Unit created successfully",
      data: { unit },
    };
  } catch (error) {
    console.error("CreateUnitService Error", error);
    return { code: 500, status: "error", message: "Failed to create unit" };
  }
};
