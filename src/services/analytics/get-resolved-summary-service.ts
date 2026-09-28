import { AnalyticsRepository, ResolvedSummaryFilters } from "@/repositories/analytics.repository";

const analyticsRepository = new AnalyticsRepository();

export const GetResolvedSummaryService = async (filters?: ResolvedSummaryFilters) => {
  try {
    const data = await analyticsRepository.getResolvedSummary(filters);
    return {
      code: 200,
      status: "success",
      data,
    };
  } catch (error) {
    console.error("GetResolvedSummaryService Error", error);
    return { code: 500, status: "error", message: "Failed to compute monthly resolution summary" };
  }
};
