import { AttachmentRepository } from "@/repositories/attachment.repository";
import { prisma } from "@/lib/prisma";
import { enqueueAssetCleanup } from "@/lib/jobs";

const attachmentRepository = new AttachmentRepository();

export const DeleteAttachmentService = async (
  id: string,
  requesterId: string,
  requesterRole: string
) => {
  try {
    const existing = await attachmentRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Attachment not found" };
    }

    // Only original uploader or ADMIN can delete
    if (!["ADMIN", "DISPATCHER"].includes(requesterRole)) {
      return {
        code: 403,
        status: "error",
        message: "Submitted evidence can only be removed by authorized staff",
      };
    }

    const removed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${existing.incidentId}::uuid FOR UPDATE`;
      const count = await tx.attachment.count({ where: { incidentId: existing.incidentId, verifiedAt: { not: null } } });
      if (count <= 1) return false;
      if (existing.publicId) await enqueueAssetCleanup(tx, existing.publicId);
      await tx.attachment.delete({ where: { attachmentId: id } });
      await tx.auditLog.create({ data: { actorId: requesterId, action: "EVIDENCE_REMOVED", entityType: "Attachment", entityId: id, metadata: { incidentId: existing.incidentId, publicId: existing.publicId } } });
      return true;
    }, { timeout: 20000 });
    if (!removed) return { code: 409, status: "error", message: "The last verified proof photo must be retained" };

    return {
      code: 200,
      status: "success",
      message: "Attachment deleted successfully",
    };
  } catch (error) {
    console.error("DeleteAttachmentService Error", error);
    return {
      code: 500,
      status: "error",
      message: "Failed to delete attachment",
    };
  }
};
