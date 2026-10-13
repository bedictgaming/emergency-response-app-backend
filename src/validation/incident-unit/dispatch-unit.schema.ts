import { z } from "zod";
import { IncidentUnitStatus } from "@/generated/prisma";

export const dispatchUnitSchema = z.object({
  params: z.object({
    incidentId: z
      .string({ message: "Incident ID is required" })
      .uuid("Incident ID must be a valid UUID"),
  }),
  body: z.object({
    unitId: z
      .string({ message: "unitId is required" })
      .uuid("unitId must be a valid UUID"),
    role: z.string().max(100, "role must not exceed 100 characters").optional(),
    status: z
      .nativeEnum(IncidentUnitStatus, {
        message:
          "status must be one of: DISPATCHED, EN_ROUTE, ON_SCENE, RETURNED",
      })
      .optional(),
  }),
});

export type DispatchUnitInput = z.infer<typeof dispatchUnitSchema>["body"];
