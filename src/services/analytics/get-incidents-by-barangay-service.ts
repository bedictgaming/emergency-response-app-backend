import { AnalyticsRepository, IncidentsByBarangayFilters } from "@/repositories/analytics.repository";

const analyticsRepository = new AnalyticsRepository();

export const GetIncidentsByBarangayService = async (filters?: IncidentsByBarangayFilters) => {
  try {
    const data = await analyticsRepository.getIncidentsByBarangay(filters);
    return {
      code: 200,
      status: "success",
      data,
    };
  } catch (error) {
    console.error("GetIncidentsByBarangayService Error", error);
    return { code: 500, status: "error", message: "Failed to compute barangay incident analytics" };
  }
};
