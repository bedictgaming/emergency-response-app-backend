import { z } from "zod";

export const createLocationSchema = z.object({
  body: z.object({
    locationName: z
      .string({ message: "Location name is required" })
      .min(1, "Location name cannot be empty"),
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

export type CreateLocationInput = z.infer<typeof createLocationSchema>["body"];
