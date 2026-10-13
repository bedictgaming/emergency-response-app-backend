import { z } from "zod";
import { IncidentUnitStatus } from "@/generated/prisma";

export const updateIncidentUnitSchema = z.object({
  params: z.object({
    id: z
      .string({ message: "IncidentUnit ID is required" })
      .uuid("IncidentUnit ID must be a valid UUID"),
  }),
  body: z.object({
    role: z.string().max(100, "role must not exceed 100 characters").optional(),
    status: z
      .nativeEnum(IncidentUnitStatus, {
        message:
          "status must be one of: DISPATCHED, EN_ROUTE, ON_SCENE, RETURNED",
      })
      .optional(),
  }),
});

export type UpdateIncidentUnitInput = z.infer<
  typeof updateIncidentUnitSchema
>["body"];
