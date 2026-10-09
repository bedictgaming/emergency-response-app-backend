import { z } from "zod";
import { TaskPriority, TaskStatus } from "@/generated/prisma";

export const updateTaskSchema = z.object({
  params: z.object({
    id: z
      .string({ message: "Task ID is required" })
      .uuid("Task ID must be a valid UUID"),
  }),
  body: z.object({
    taskName: z
      .string()
      .min(3, "taskName must be at least 3 characters")
      .max(200, "taskName must not exceed 200 characters")
      .optional(),
    description: z.string().optional(),
    priority: z
      .nativeEnum(TaskPriority, {
        message: "priority must be one of: LOW, MEDIUM, HIGH",
      })
      .optional(),
    status: z
      .nativeEnum(TaskStatus, {
        message: "status must be one of: PENDING, IN_PROGRESS, DONE",
      })
      .optional(),
    assignedTo: z.null({ message: "Responder assignments have been retired" }).optional(),
    dueAt: z
      .string()
      .datetime({ message: "dueAt must be a valid ISO 8601 datetime" })
      .nullable()
      .optional()
      .transform((val) => (val ? new Date(val) : val === null ? null : undefined)),
  }),
});

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>["body"];
