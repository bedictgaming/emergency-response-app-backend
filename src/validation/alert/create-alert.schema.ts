import { z } from "zod";
import { AlertType, AlertSeverity } from "@/generated/prisma";

export const createAlertSchema = z.object({
  body: z.object({
    alertType: z.nativeEnum(AlertType, {
      message:
        "alertType must be one of: WEATHER, SECURITY, MEDICAL, FIRE, GENERAL",
    }),
    message: z
      .string({ message: "message is required" })
      .min(5, "message must be at least 5 characters")
      .max(1000, "message cannot exceed 1000 characters"),
    severity: z
      .nativeEnum(AlertSeverity, {
        message: "severity must be one of: INFO, WARNING, CRITICAL",
      })
      .optional(),
    incidentId: z
      .string()
      .uuid("incidentId must be a valid UUID")
      .optional(),
    locationId: z
      .string()
      .uuid("locationId must be a valid UUID")
      .optional(),
  }),
});

export type CreateAlertInput = z.infer<typeof createAlertSchema>["body"];
