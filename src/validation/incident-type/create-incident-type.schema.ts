import { z } from "zod";

export const createIncidentTypeSchema = z.object({
  body: z.object({
    typeName: z
      .string({ message: "typeName is required" })
      .min(2, "typeName must be at least 2 characters")
      .max(100, "typeName must not exceed 100 characters"),
    description: z.string().optional(),
  }),
});

export type CreateIncidentTypeInput = z.infer<typeof createIncidentTypeSchema>["body"];
