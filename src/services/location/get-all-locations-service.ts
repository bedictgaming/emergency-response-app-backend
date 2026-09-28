import { LocationRepository } from "@/repositories/location.repository";

const locationRepository = new LocationRepository();

export const GetAllLocationsService = async () => {
  try {
    const locations = await locationRepository.findAll();

    return {
      code: 200,
      status: "success",
      data: { locations },
    };
  } catch (error) {
    console.error("GetAllLocationsService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch locations" };
  }
};
