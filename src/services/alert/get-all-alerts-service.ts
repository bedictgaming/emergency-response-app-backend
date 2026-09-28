import { AlertRepository } from "@/repositories/alert.repository";
import { AlertType, AlertSeverity } from "@/generated/prisma";
import { isTransientDatabaseConnectionError, retryTransientDatabaseRead } from "@/lib/transient-database-read";

const alertRepository = new AlertRepository();

interface GetAllAlertsFilters {
  alertType?: AlertType;
  severity?: AlertSeverity;
  incidentId?: string;
  locationId?: string;
}

export const GetAllAlertsService = async (filters?: GetAllAlertsFilters) => {
  try {
    const alerts = await retryTransientDatabaseRead(() => alertRepository.findAll(filters));

    return {
      code: 200,
      status: "success",
      data: { alerts },
    };
  } catch (error) {
    if (isTransientDatabaseConnectionError(error)) {
      return { code: 503, status: "error", message: "Alerts are temporarily unavailable. Please retry shortly." };
    }
    console.error("GetAllAlertsService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch alerts" };
  }
};
