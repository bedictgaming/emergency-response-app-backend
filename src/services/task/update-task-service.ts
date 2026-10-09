import { TaskRepository } from "@/repositories/task.repository";
import { UpdateTaskInput } from "@/schema/task/update-task.schema";
import { prisma } from "@/lib/prisma";
import { publishEmergencyEvent } from "@/lib/events";
import { isWorkflowConflict } from "@/lib/workflow-error";

const taskRepository = new TaskRepository();

// Valid status transition map
const VALID_TASK_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["IN_PROGRESS"],
  IN_PROGRESS: ["DONE", "PENDING"],
  DONE: [],
};

export const UpdateTaskService = async (
  id: string,
  data: UpdateTaskInput,
  requesterId: string,  // userId from JWT
  requesterRole: string
) => {
  try {
    if (requesterRole !== "ADMIN" && requesterRole !== "DISPATCHER") {
      return { code: 403, status: "error", message: "Only administrators and dispatchers can update tasks" };
    }
    if (data.assignedTo != null) return { code: 400, status: "error", message: "Responder assignments have been retired" };
    const existing = await taskRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Task not found" };
    }

    // Validate status transition if status is being changed
    if (data.status && data.status !== existing.status) {
      const allowedNext = VALID_TASK_TRANSITIONS[existing.status] ?? [];
      if (!allowedNext.includes(data.status)) {
        return {
          code: 400,
          status: "error",
          message: `Invalid status transition: cannot move from "${existing.status}" to "${data.status}". Allowed: ${allowedNext.join(", ") || "none"}`,
        };
      }
    }

    const task = await prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { taskId: id, status: existing.status, assignedTo: existing.assignedTo, taskName: existing.taskName, priority: existing.priority, description: existing.description, dueAt: existing.dueAt },
        data, include: { incident: true, assignee: { include: { user: { select: { id: true, name: true, email: true } } } } },
      });
      await tx.auditLog.create({ data: { actorId: requesterId, action: "TASK_UPDATED", entityType: "Task", entityId: id, metadata: { changes: data } } });
      return updated;
    });
    publishEmergencyEvent({ type: "task.updated", entityId: id });

    return {
      code: 200,
      status: "success",
      message: "Task updated successfully",
      data: { task },
    };
  } catch (error) {
    if (isWorkflowConflict(error)) return { code: 409, status: "error", message: "Task changed concurrently. Refresh and retry." };
    console.error("UpdateTaskService Error", error);
    return { code: 500, status: "error", message: "Failed to update task" };
  }
};
