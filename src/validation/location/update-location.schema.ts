import { z } from "zod";

export const updateLocationSchema = z.object({
  params: z.object({
    id: z.string({ message: "Location ID is required" }).uuid("Invalid location ID format"),
  }),
  body: z.object({
    locationName: z.string().min(1, "Location name cannot be empty").optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    province: z.string().optional(),
    latitude: z
      .number()
      .min(-90, "Latitude must be between -90 and 90")
      .max(90, "Latitude must be between -90 and 90")
      .optional(),
    longitude: z
      .number()
      .min(-180, "Longitude must be between -180 and 180")
      .max(180, "Longitude must be between -180 and 180")
      .optional(),
  }),
});

export type UpdateLocationInput = z.infer<typeof updateLocationSchema>["body"];
