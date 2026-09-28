import { z } from "zod";
import { ResponderStatus } from "@/generated/prisma";

export const updateResponderSchema = z.object({
  params: z.object({
    id: z
      .string({ message: "Responder ID is required" })
      .uuid("Responder ID must be a valid UUID"),
  }),
  body: z.object({
    unitId: z.string().uuid("unitId must be a valid UUID").optional(),
    rank: z.string().max(100, "rank must not exceed 100 characters").optional(),
    certifications: z
      .string()
      .max(500, "certifications must not exceed 500 characters")
      .optional(),
    status: z
      .nativeEnum(ResponderStatus, {
        message: "status must be one of: AVAILABLE, DEPLOYED, OFF_DUTY",
      })
      .optional(),
  }),
});

export type UpdateResponderInput = z.infer<typeof updateResponderSchema>["body"];
