import { TaskRepository } from "@/repositories/task.repository";
import { CreateTaskInput } from "@/validation/task/create-task.schema";
import { prisma } from "@/lib/prisma";
import { publishEmergencyEvent } from "@/lib/events";
import { enqueueNotification } from "@/lib/jobs";
import { WorkflowConflict, isWorkflowConflict } from '@/domain/workflow-error.policy';
import { nearbyActorService, requireNearbyAdmission } from '@/lib/nearby-review';

const taskRepository = new TaskRepository();

export const CreateTaskService = async (
  incidentId: string,
  data: CreateTaskInput,
  actorId?: string,
) => {
  try {
    if (data.assignedTo != null) return { code: 400, status: "error", message: "Responder assignments have been retired" };
    // Verify incident exists
    const incident = await taskRepository.findIncidentById(incidentId);
    if (!incident) {
      return { code: 404, status: "error", message: "Incident not found" };
    }

    // Verify incident is not already closed
    if (incident.status === "CLOSED" || incident.status === 'CANCELLED') {
      return {
        code: 400,
        status: "error",
        message: "Cannot add tasks to a closed or cancelled incident",
      };
    }

    if (incident.verificationStatus !== "VERIFIED") {
      return { code: 409, status: "error", message: "Tasks can only be created for verified incidents" };
    }

    const task = await prisma.$transaction(async (tx) => {
      const service = await nearbyActorService(tx, actorId);
      // Fence task creation against cancellation/deletion under the same parent
      // lock. A middleware/preflight read cannot protect this interval.
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${incidentId}::uuid FOR UPDATE`;
      await requireNearbyAdmission(tx, incidentId, service);
      const current = await tx.incident.findUnique({ where: { incidentId } });
      if (!current || ['CLOSED', 'CANCELLED'].includes(current.status) || current.verificationStatus !== 'VERIFIED')
        throw new WorkflowConflict('This report no longer accepts response tasks.');
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
    if (isWorkflowConflict(error)) return { code: 409, status: 'error', message: 'Report changed; refresh before creating a task.' };
    console.error("CreateTaskService Error", error);
    return { code: 500, status: "error", message: "Failed to create task" };
  }
};
