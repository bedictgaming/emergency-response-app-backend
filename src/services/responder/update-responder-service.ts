import { ResponderRepository } from "@/repositories/responder.repository";
import { UpdateResponderInput } from "@/schema/responder/update-responder.schema";

const responderRepository = new ResponderRepository();

export const UpdateResponderService = async (
  id: string,
  data: UpdateResponderInput
) => {
  try {
    const existing = await responderRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Responder not found" };
    }

    // Verify unitId if being transferred to a different unit
    if (data.unitId && data.unitId !== existing.unitId) {
      const unit = await responderRepository.findUnitById(data.unitId);
      if (!unit) {
        return {
          code: 404,
          status: "error",
          message: "Unit not found. Please provide a valid unitId.",
        };
      }
    }

    const responder = await responderRepository.update(id, data);

    return {
      code: 200,
      status: "success",
      message: "Responder updated successfully",
      data: { responder },
    };
  } catch (error) {
    console.error("UpdateResponderService Error", error);
    return { code: 500, status: "error", message: "Failed to update responder" };
  }
};
