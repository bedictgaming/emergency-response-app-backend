import { BarangayRepository } from "@/repositories/barangay.repository";
import { UpdateBarangayInput } from "@/schema/barangay/update-barangay.schema";

const barangayRepository = new BarangayRepository();

export const UpdateBarangayService = async (
  barangayId: string,
  input: UpdateBarangayInput
) => {
  try {
    const existing = await barangayRepository.findById(barangayId);
    if (!existing) {
      return { code: 404, status: "error", message: "Barangay not found" };
    }

    const updated = await barangayRepository.updateStatus(barangayId, input.status);

    return {
      code: 200,
      status: "success",
      message: "Barangay status updated successfully",
      data: { barangay: updated },
    };
  } catch (error) {
    console.error("UpdateBarangayService Error", error);
    return { code: 500, status: "error", message: "Failed to update barangay status" };
  }
};
