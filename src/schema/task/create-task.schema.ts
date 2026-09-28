import { z } from "zod";
import { TaskPriority } from "@/generated/prisma";

export const createTaskSchema = z.object({
  body: z.object({
    taskName: z
      .string({ message: "taskName is required" })
      .min(3, "taskName must be at least 3 characters")
      .max(200, "taskName must not exceed 200 characters"),
    description: z.string().optional(),
    priority: z
      .nativeEnum(TaskPriority, {
        message: "priority must be one of: LOW, MEDIUM, HIGH",
      })
      .optional(),
    assignedTo: z
      .string()
      .uuid("assignedTo must be a valid responder UUID")
      .optional(),
    dueAt: z
      .string()
      .datetime({ message: "dueAt must be a valid ISO 8601 datetime" })
      .optional()
      .transform((val) => (val ? new Date(val) : undefined)),
  }),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>["body"];
