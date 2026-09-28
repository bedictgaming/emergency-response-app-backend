import { TaskRepository } from "@/repositories/task.repository";
import { CreateTaskInput } from "@/schema/task/create-task.schema";
import { prisma } from "@/lib/prisma";
import { publishEmergencyEvent } from "@/lib/events";
import { enqueueNotification } from "@/lib/jobs";

const taskRepository = new TaskRepository();

export const CreateTaskService = async (
  incidentId: string,
  data: CreateTaskInput,
  actorId?: string,
) => {
  try {
    // Verify incident exists
    const incident = await taskRepository.findIncidentById(incidentId);
    if (!incident) {
      return { code: 404, status: "error", message: "Incident not found" };
    }

    // Verify incident is not already closed
    if (incident.status === "CLOSED") {
      return {
        code: 400,
        status: "error",
        message: "Cannot add tasks to a CLOSED incident",
      };
    }

    if (incident.verificationStatus !== "VERIFIED") {
      return { code: 409, status: "error", message: "Tasks can only be created for verified incidents" };
    }

    // Verify assignedTo responder exists if provided
    if (data.assignedTo) {
      const responder = await taskRepository.findResponderById(data.assignedTo);
      if (!responder) {
        return {
          code: 404,
          status: "error",
          message: "Responder not found. Please provide a valid assignedTo UUID.",
        };
      }
    }

    const task = await prisma.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: { incidentId, taskName: data.taskName, description: data.description, priority: data.priority, assignedTo: data.assignedTo, dueAt: data.dueAt },
        include: { incident: { select: { incidentId: true, title: true, status: true } }, assignee: { include: { user: { select: { id: true, name: true, email: true } } } } },
      });
      await tx.auditLog.create({ data: { actorId, action: "TASK_CREATED", entityType: "Task", entityId: created.taskId, metadata: { incidentId, assignedTo: data.assignedTo } } });
      if (created.assignee?.user?.id) await enqueueNotification(tx, "TASK_CREATED", {
        title: "New response task", body: created.taskName,
        data: { taskId: created.taskId, incidentId, type: "task" },
      }, [created.assignee.user.id]);
      return created;
    });
    publishEmergencyEvent({ type: "task.updated", entityId: task.taskId });

    return {
      code: 201,
      status: "success",
      message: "Task created successfully",
      data: { task },
    };
  } catch (error) {
    console.error("CreateTaskService Error", error);
    return { code: 500, status: "error", message: "Failed to create task" };
  }
};
