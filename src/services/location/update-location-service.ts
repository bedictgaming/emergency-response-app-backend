import { LocationRepository } from "@/repositories/location.repository";
import { UpdateLocationInput } from "@/schema/location/update-location.schema";

const locationRepository = new LocationRepository();

export const UpdateLocationService = async (id: string, data: UpdateLocationInput) => {
  try {
    const existing = await locationRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Location not found" };
    }

    const location = await locationRepository.update(id, data);

    return {
      code: 200,
      status: "success",
      message: "Location updated successfully",
      data: { location },
    };
  } catch (error) {
    console.error("UpdateLocationService Error", error);
    return { code: 500, status: "error", message: "Failed to update location" };
  }
};
