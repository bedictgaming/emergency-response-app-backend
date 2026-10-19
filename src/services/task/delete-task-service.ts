import { TaskRepository } from "@/repositories/task.repository";
import { publishEmergencyEvent } from '@/lib/events';

const taskRepository = new TaskRepository();

export const DeleteTaskService = async (id: string) => {
  try {
    const existing = await taskRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Task not found" };
    }

    await taskRepository.delete(id);
    // The deleted task can no longer authorize its own event. Invalidate via
    // the surviving parent, whose existing scope is checked for every viewer.
    publishEmergencyEvent({ type: 'incident.updated', entityId: existing.incidentId });

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
