import { ResponderRepository } from "@/repositories/responder.repository";
import { prisma } from "@/lib/prisma";

const responderRepository = new ResponderRepository();

export const DeleteResponderService = async (id: string) => {
  try {
    const existing = await responderRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Responder not found" };
    }

    // Check if responder has active/in-progress tasks
    const hasTasks = await responderRepository.hasActiveTasks(id);
    if (hasTasks) {
      return {
        code: 409,
        status: "error",
        message:
          "Cannot delete responder — they have pending or in-progress tasks assigned. Reassign or complete those tasks first.",
      };
    }

    await prisma.$transaction(async tx => {
      await tx.task.updateMany({ where: { assignedTo: id }, data: { assignedTo: null } });
      await tx.responder.delete({ where: { responderId: id } });
      await tx.user.update({ where: { id: existing.user.id }, data: { role: "USER" } });
      await tx.token.updateMany({ where: { userId: existing.user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { action: "RESPONDER_PROFILE_DELETED", entityType: "Responder", entityId: id, metadata: { userId: existing.user.id } } });
    });

    return {
      code: 200,
      status: "success",
      message: "Responder profile deleted successfully",
    };
  } catch (error) {
    console.error("DeleteResponderService Error", error);
    return { code: 500, status: "error", message: "Failed to delete responder" };
  }
};
