import { z } from "zod";
import { ResponseService, SeverityLevel } from "@/generated/prisma";

export const createIncidentSchema = z.object({
  body: z.object({
    title: z
      .string({ message: "Title is required" })
      .min(3, "Title must be at least 3 characters"),
    description: z.string().optional(),
    typeId: z
      .string()
      .uuid("typeId must be a valid UUID")
      .optional(),
    category: z.string().optional(),
    typeName: z.string().optional(),
    locationId: z
      .string()
      .uuid("locationId must be a valid UUID")
      .optional(),
    locationName: z.string().optional(),
    address: z.string().optional(),
    barangayId: z
      .string()
      .uuid("barangayId must be a valid UUID")
      .optional(),
    barangayName: z.string().optional(),
    severityLevel: z
      .nativeEnum(SeverityLevel)
      .default(SeverityLevel.MEDIUM)
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
    reporterPhone: z.string().optional(),
    requestedServices: z.array(z.nativeEnum(ResponseService)).max(4).optional(),
    duplicateOverrideReason: z.string().trim().min(10).max(500).optional(),
    proofAttachment: z.object({
      publicId: z.string().min(3).max(500),
      fileName: z.string().min(1).max(255),
    }).optional(),
  }).superRefine((body, context) => {
    const isOther = (body.category || body.typeName || "").trim().toLowerCase() === "other";
    const requested = new Set(body.requestedServices ?? []);
    if (isOther && requested.size < 2) {
      context.addIssue({
        code: "custom",
        path: ["requestedServices"],
        message: "Select at least two response services for an Other emergency",
      });
    }
    if (!isOther && requested.size > 0) {
      context.addIssue({
        code: "custom",
        path: ["requestedServices"],
        message: "Multiple response services are only available for the Other category",
      });
    }
  }),
});

export type CreateIncidentInput = z.infer<typeof createIncidentSchema>["body"];
