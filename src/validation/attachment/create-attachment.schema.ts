import { z } from "zod";

export const createAttachmentSchema = z.object({
  params: z.object({
    incidentId: z
      .string({ message: "Incident ID is required" })
      .uuid("Incident ID must be a valid UUID"),
  }),
  body: z.object({
    fileName: z
      .string({ message: "fileName is required" })
      .min(1, "fileName cannot be empty")
      .max(255, "fileName cannot exceed 255 characters"),
    publicId: z.string().min(3).max(500),
  }),
});

export type CreateAttachmentInput = z.infer<
  typeof createAttachmentSchema
>["body"];
