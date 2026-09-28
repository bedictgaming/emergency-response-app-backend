import { TaskRepository } from "@/repositories/task.repository";
import { Prisma, TaskStatus, TaskPriority } from "@/generated/prisma";

const taskRepository = new TaskRepository();

interface GetAllTasksFilters {
  incidentId?: string;
  assignedTo?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedUserId?: string;
  taskScope?: Prisma.TaskWhereInput;
}

export const GetAllTasksService = async (filters?: GetAllTasksFilters) => {
  try {
    const tasks = await taskRepository.findAll(filters);

    return {
      code: 200,
      status: "success",
      data: { tasks },
    };
  } catch (error) {
    console.error("GetAllTasksService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch tasks" };
  }
};
