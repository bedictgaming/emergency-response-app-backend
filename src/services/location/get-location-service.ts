import { LocationRepository } from "@/repositories/location.repository";

const locationRepository = new LocationRepository();

export const GetLocationService = async (id: string) => {
  try {
    const location = await locationRepository.findById(id);

    if (!location) {
      return { code: 404, status: "error", message: "Location not found" };
    }

    return {
      code: 200,
      status: "success",
      data: { location },
    };
  } catch (error) {
    console.error("GetLocationService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch location" };
  }
};
