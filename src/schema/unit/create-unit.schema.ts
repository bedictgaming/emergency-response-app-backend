import { z } from "zod";
import { UnitStatus } from "@/generated/prisma";

export const createUnitSchema = z.object({
  body: z.object({
    unitName: z
      .string({ message: "unitName is required" })
      .min(2, "unitName must be at least 2 characters")
      .max(100, "unitName must not exceed 100 characters"),
    unitType: z
      .string({ message: "unitType is required" })
      .min(2, "unitType must be at least 2 characters")
      .max(100, "unitType must not exceed 100 characters"),
    status: z
      .nativeEnum(UnitStatus, {
        message: "status must be one of: AVAILABLE, DEPLOYED, OUT_OF_SERVICE",
      })
      .optional(),
  }),
});

export type CreateUnitInput = z.infer<typeof createUnitSchema>["body"];
