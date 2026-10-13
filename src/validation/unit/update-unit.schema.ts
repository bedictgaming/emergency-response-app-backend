import { z } from "zod";
import { UnitStatus } from "@/generated/prisma";

export const updateUnitSchema = z.object({
  params: z.object({
    id: z
      .string({ message: "Unit ID is required" })
      .uuid("Unit ID must be a valid UUID"),
  }),
  body: z.object({
    unitName: z
      .string()
      .min(2, "unitName must be at least 2 characters")
      .max(100, "unitName must not exceed 100 characters")
      .optional(),
    unitType: z
      .string()
      .min(2, "unitType must be at least 2 characters")
      .max(100, "unitType must not exceed 100 characters")
      .optional(),
    status: z
      .nativeEnum(UnitStatus, {
        message: "status must be one of: AVAILABLE, DEPLOYED, OUT_OF_SERVICE",
      })
      .optional(),
  }),
});

export type UpdateUnitInput = z.infer<typeof updateUnitSchema>["body"];
