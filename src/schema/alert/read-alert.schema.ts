import { z } from "zod";
import { AlertSeverity, AlertType } from "@/generated/prisma";

export const readAlertSchema = z.object({
  params: z.object({ id: z.string().uuid("Alert ID must be a valid UUID") }),
});

export const listAlertsSchema = z.object({
  query: z.object({
    alertType: z.nativeEnum(AlertType).optional(),
    severity: z.nativeEnum(AlertSeverity).optional(),
    incidentId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
  }),
});
