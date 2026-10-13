import { z } from "zod";
import { ResourceStatus } from "@/generated/prisma";

export const updateResourceSchema = z.object({
  params: z.object({
    id: z
      .string({ message: "Resource ID is required" })
      .uuid("Resource ID must be a valid UUID"),
  }),
  body: z.object({
    resourceName: z
      .string()
      .min(2, "resourceName must be at least 2 characters")
      .max(100, "resourceName must not exceed 100 characters")
      .optional(),
    resourceType: z
      .string()
      .min(2, "resourceType must be at least 2 characters")
      .max(100, "resourceType must not exceed 100 characters")
      .optional(),
    quantity: z
      .number()
      .int("quantity must be an integer")
      .min(0, "quantity cannot be negative")
      .optional(),
    status: z
      .nativeEnum(ResourceStatus, {
        message: "status must be one of: AVAILABLE, IN_USE, MAINTENANCE, DEPLETED",
      })
      .optional(),
    unitId: z.string().uuid("unitId must be a valid UUID").optional(),
  }),
});

export type UpdateResourceInput = z.infer<typeof updateResourceSchema>["body"];
