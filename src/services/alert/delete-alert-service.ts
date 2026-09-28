import { AlertRepository } from "@/repositories/alert.repository";

const alertRepository = new AlertRepository();

export const DeleteAlertService = async (id: string) => {
  try {
    const existing = await alertRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Alert not found" };
    }

    await alertRepository.delete(id);

    return {
      code: 200,
      status: "success",
      message: "Alert deleted successfully",
    };
  } catch (error) {
    console.error("DeleteAlertService Error", error);
    return { code: 500, status: "error", message: "Failed to delete alert" };
  }
};
