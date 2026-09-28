import { TaskRepository } from "@/repositories/task.repository";

const taskRepository = new TaskRepository();

export const GetTaskService = async (id: string, requesterId?: string, requesterRole?: string) => {
  try {
    const task = await taskRepository.findById(id);

    if (!task) {
      return { code: 404, status: "error", message: "Task not found" };
    }
    if (requesterRole === "RESPONDER" && task.assignee?.user?.id !== requesterId) {
      return { code: 403, status: "error", message: "You can only view tasks assigned to you" };
    }

    return {
      code: 200,
      status: "success",
      data: { task },
    };
  } catch (error) {
    console.error("GetTaskService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch task" };
  }
};
