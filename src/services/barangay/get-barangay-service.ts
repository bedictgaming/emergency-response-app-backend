import { BarangayRepository } from "@/repositories/barangay.repository";

const barangayRepository = new BarangayRepository();

export const GetBarangayService = async (barangayId: string) => {
  try {
    const barangay = await barangayRepository.findById(barangayId);
    if (!barangay) {
      return { code: 404, status: "error", message: "Barangay not found" };
    }

    return {
      code: 200,
      status: "success",
      data: { barangay },
    };
  } catch (error) {
    console.error("GetBarangayService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch barangay" };
  }
};
