import { AnalyticsRepository, IncidentsByTypeFilters } from "@/repositories/analytics.repository";

const analyticsRepository = new AnalyticsRepository();

export const GetIncidentsByTypeService = async (filters?: IncidentsByTypeFilters) => {
  try {
    const data = await analyticsRepository.getIncidentsByType(filters);
    return {
      code: 200,
      status: "success",
      data,
    };
  } catch (error) {
    console.error("GetIncidentsByTypeService Error", error);
    return { code: 500, status: "error", message: "Failed to compute emergency type analytics" };
  }
};
