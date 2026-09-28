import { BarangayRepository } from "@/repositories/barangay.repository";
import { Prisma } from "@/generated/prisma";

const barangayRepository = new BarangayRepository();

export const GetBarangayIncidentsService = async (barangayId: string, scope: Prisma.IncidentWhereInput) => {
  try {
    const barangay = await barangayRepository.findById(barangayId);
    if (!barangay) {
      return { code: 404, status: "error", message: "Barangay not found" };
    }

    const incidents = await barangayRepository.findIncidentsByBarangayId(barangayId, scope);

    return {
      code: 200,
      status: "success",
      data: {
        barangay: {
          barangayId: barangay.barangayId,
          name: barangay.name,
          status: barangay.status,
        },
        incidents,
      },
    };
  } catch (error) {
    console.error("GetBarangayIncidentsService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch barangay incidents" };
  }
};
