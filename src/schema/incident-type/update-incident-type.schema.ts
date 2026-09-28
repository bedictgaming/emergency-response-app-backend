import { z } from "zod";

export const updateIncidentTypeSchema = z.object({
  params: z.object({
    id: z
      .string({ message: "Incident type ID is required" })
      .uuid("Incident type ID must be a valid UUID"),
  }),
  body: z.object({
    typeName: z
      .string()
      .min(2, "typeName must be at least 2 characters")
      .max(100, "typeName must not exceed 100 characters")
      .optional(),
    description: z.string().optional(),
  }),
});

export type UpdateIncidentTypeInput = z.infer<typeof updateIncidentTypeSchema>["body"];
