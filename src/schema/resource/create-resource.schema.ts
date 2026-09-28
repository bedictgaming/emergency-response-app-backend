import { z } from "zod";
import { ResourceStatus } from "@/generated/prisma";

export const createResourceSchema = z.object({
  body: z.object({
    resourceName: z
      .string({ message: "resourceName is required" })
      .min(2, "resourceName must be at least 2 characters")
      .max(100, "resourceName must not exceed 100 characters"),
    resourceType: z
      .string({ message: "resourceType is required" })
      .min(2, "resourceType must be at least 2 characters")
      .max(100, "resourceType must not exceed 100 characters"),
    quantity: z
      .number({ message: "quantity is required" })
      .int("quantity must be an integer")
      .min(0, "quantity cannot be negative"),
    status: z
      .nativeEnum(ResourceStatus, {
        message: "status must be one of: AVAILABLE, IN_USE, MAINTENANCE, DEPLETED",
      })
      .optional(),
    unitId: z
      .string({ message: "unitId is required" })
      .uuid("unitId must be a valid UUID"),
  }),
});

export type CreateResourceInput = z.infer<typeof createResourceSchema>["body"];
