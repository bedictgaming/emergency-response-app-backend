import { LocationRepository } from "@/repositories/location.repository";

const locationRepository = new LocationRepository();

export const DeleteLocationService = async (id: string) => {
  try {
    const existing = await locationRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Location not found" };
    }
    if (await locationRepository.referenceCount(id)) {
      return { code: 409, status: "error", message: "Cannot delete a location referenced by incidents or alerts" };
    }

    await locationRepository.delete(id);

    return {
      code: 200,
      status: "success",
      message: "Location deleted successfully",
    };
  } catch (error) {
    console.error("DeleteLocationService Error", error);
    return { code: 500, status: "error", message: "Failed to delete location" };
  }
};
