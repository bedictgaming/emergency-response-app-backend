import { LocationRepository } from "@/repositories/location.repository";
import { CreateLocationInput } from "@/schema/location/create-location.schema";

const locationRepository = new LocationRepository();

export const CreateLocationService = async (data: CreateLocationInput) => {
  try {
    const location = await locationRepository.create(data);

    return {
      code: 201,
      status: "success",
      message: "Location created successfully",
      data: { location },
    };
  } catch (error) {
    console.error("CreateLocationService Error", error);
    return { code: 500, status: "error", message: "Failed to create location" };
  }
};
