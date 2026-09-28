import { TaskRepository } from "@/repositories/task.repository";

const taskRepository = new TaskRepository();

export const DeleteTaskService = async (id: string) => {
  try {
    const existing = await taskRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Task not found" };
    }

    await taskRepository.delete(id);

    return {
      code: 200,
      status: "success",
      message: "Task deleted successfully",
    };
  } catch (error) {
    console.error("DeleteTaskService Error", error);
    return { code: 500, status: "error", message: "Failed to delete task" };
  }
};
