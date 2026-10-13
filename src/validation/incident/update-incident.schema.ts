import { z } from "zod";
import { IncidentStatus, SeverityLevel } from "@/generated/prisma";

export const updateIncidentSchema = z.object({
  params: z.object({
    id: z
      .string({ message: "Incident ID is required" })
      .uuid("Incident ID must be a valid UUID"),
  }),
  body: z.object({
    title: z.string().min(3, "Title must be at least 3 characters").optional(),
    description: z.string().optional(),
    typeId: z.string().uuid("typeId must be a valid UUID").optional(),
    locationId: z.string().uuid("locationId must be a valid UUID").optional(),
    severityLevel: z
      .nativeEnum(SeverityLevel, {
        message: "severityLevel must be one of: LOW, MEDIUM, HIGH, CRITICAL",
      })
      .optional(),
    status: z
      .nativeEnum(IncidentStatus, {
        message: "status must be one of: OPEN, ACTIVE, RESOLVED, CLOSED",
      })
      .optional(),
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

export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>["body"];
