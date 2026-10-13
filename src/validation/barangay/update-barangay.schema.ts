import { z } from "zod";

export const updateBarangaySchema = z.object({
  body: z.object({
    status: z.enum(["ACTIVE", "INACTIVE"], {
      message: "Status must be either ACTIVE or INACTIVE",
    }),
  }),
});

export type UpdateBarangayInput = z.infer<typeof updateBarangaySchema>["body"];
