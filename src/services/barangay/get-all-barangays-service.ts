import { BarangayRepository } from "@/repositories/barangay.repository";

const barangayRepository = new BarangayRepository();

export const GetAllBarangaysService = async () => {
  try {
    const barangays = await barangayRepository.findAll();
    return {
      code: 200,
      status: "success",
      data: { barangays },
    };
  } catch (error) {
    console.error("GetAllBarangaysService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch barangays" };
  }
};
