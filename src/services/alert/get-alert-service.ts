import { AlertRepository } from "@/repositories/alert.repository";
import { isTransientDatabaseConnectionError, retryTransientDatabaseRead } from "@/lib/transient-database-read";

const alertRepository = new AlertRepository();

export const GetAlertService = async (id: string) => {
  try {
    const alert = await retryTransientDatabaseRead(() => alertRepository.findById(id));

    if (!alert) {
      return { code: 404, status: "error", message: "Alert not found" };
    }

    return {
      code: 200,
      status: "success",
      data: { alert },
    };
  } catch (error) {
    if (isTransientDatabaseConnectionError(error)) {
      return { code: 503, status: "error", message: "Alerts are temporarily unavailable. Please retry shortly." };
    }
    console.error("GetAlertService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch alert" };
  }
};
