import { z } from "zod";
import { ResponderStatus } from "@/generated/prisma";

export const createResponderSchema = z.object({
  body: z.object({
    userId: z
      .string({ message: "userId is required" })
      .uuid("userId must be a valid UUID"),
    unitId: z
      .string({ message: "unitId is required" })
      .uuid("unitId must be a valid UUID"),
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

export type CreateResponderInput = z.infer<typeof createResponderSchema>["body"];
