import { AnalyticsRepository } from "@/repositories/analytics.repository";

const analyticsRepository = new AnalyticsRepository();

export const GetDashboardAnalyticsService = async (scope = {}) => {
  try {
    const data = await analyticsRepository.getDashboardAnalytics(scope);
    return {
      code: 200,
      status: "success",
      data,
    };
  } catch (error) {
    console.error("GetDashboardAnalyticsService Error", error);
    return { code: 500, status: "error", message: "Failed to compute dashboard analytics" };
  }
};
