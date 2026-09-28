import { prisma } from "@/lib/prisma";
import { Prisma, TaskPriority, TaskStatus } from "@/generated/prisma";

interface CreateTaskData {
  incidentId: string;
  taskName: string;
  description?: string;
  priority?: TaskPriority;
  assignedTo?: string;
  dueAt?: Date;
}

interface UpdateTaskData {
  taskName?: string;
  description?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  assignedTo?: string | null;
  dueAt?: Date | null;
}

interface TaskFilters {
  incidentId?: string;
  assignedTo?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedUserId?: string;
  taskScope?: Prisma.TaskWhereInput;
}

export class TaskRepository {
  async findAll(filters?: TaskFilters) {
    return await prisma.task.findMany({
      where: {
        ...(filters?.incidentId && { incidentId: filters.incidentId }),
        ...(filters?.assignedTo && { assignedTo: filters.assignedTo }),
        ...(filters?.status && { status: filters.status }),
        ...(filters?.priority && { priority: filters.priority }),
        ...(filters?.assignedUserId && { assignee: { userId: filters.assignedUserId } }),
        ...(filters?.taskScope && { AND: [filters.taskScope] }),
      },
      include: {
        incident: {
          select: {
            incidentId: true,
            title: true,
            status: true,
            severityLevel: true,
          },
        },
        assignee: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
      orderBy: [{ priority: "desc" }, { dueAt: "asc" }, { createdAt: "asc" }],
    });
  }

  async findById(id: string) {
    return await prisma.task.findUnique({
      where: { taskId: id },
      include: {
        incident: {
          select: {
            incidentId: true,
            title: true,
            status: true,
            severityLevel: true,
            location: true,
          },
        },
        assignee: {
          include: {
            user: { select: { id: true, name: true, email: true, role: true } },
            unit: { select: { unitId: true, unitName: true, unitType: true } },
          },
        },
      },
    });
  }

  async create(data: CreateTaskData) {
    return await prisma.task.create({
      data: {
        incidentId: data.incidentId,
        taskName: data.taskName,
        description: data.description,
        priority: data.priority ?? TaskPriority.MEDIUM,
        assignedTo: data.assignedTo,
        dueAt: data.dueAt,
      },
      include: {
        incident: {
          select: { incidentId: true, title: true, status: true },
        },
        assignee: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
  }

  async update(id: string, data: UpdateTaskData) {
    return await prisma.task.update({
      where: { taskId: id },
      data: {
        ...(data.taskName && { taskName: data.taskName }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.priority && { priority: data.priority }),
        ...(data.status && { status: data.status }),
        ...(data.assignedTo !== undefined && { assignedTo: data.assignedTo }),
        ...(data.dueAt !== undefined && { dueAt: data.dueAt }),
      },
      include: {
        incident: {
          select: { incidentId: true, title: true, status: true },
        },
        assignee: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
  }

  async delete(id: string) {
    return await prisma.task.delete({
      where: { taskId: id },
    });
  }

  async findIncidentById(incidentId: string) {
    return await prisma.incident.findUnique({
      where: { incidentId },
    });
  }

  async findResponderById(responderId: string) {
    return await prisma.responder.findUnique({
      where: { responderId },
    });
  }
}
