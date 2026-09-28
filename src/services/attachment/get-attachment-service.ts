import { AttachmentRepository } from "@/repositories/attachment.repository";
import { prisma } from '@/lib/prisma';
import { responderIncidentScope } from '@/lib/incident-scope';
import { protectAttachment } from '@/lib/evidence';

const attachmentRepository = new AttachmentRepository();

export const GetAttachmentService = async (id: string, requesterId: string, requesterRole: string) => {
  try {
    const attachment = await attachmentRepository.findById(id);

    if (!attachment) {
      return { code: 404, status: "error", message: "Attachment not found" };
    }
    if (requesterRole === "USER" && attachment.incident.reportedBy !== requesterId) {
      return { code: 403, status: "error", message: "You cannot access another citizen's evidence" };
    }
    if (requesterRole === "RESPONDER" && !await prisma.incident.findFirst({ where: { incidentId: attachment.incidentId, ...responderIncidentScope(requesterId) }, select: { incidentId: true } })) {
      return { code: 403, status: 'error', message: 'Evidence is outside your assignments' };
    }

    return {
      code: 200,
      status: "success",
      data: { attachment: protectAttachment(attachment) },
    };
  } catch (error) {
    console.error("GetAttachmentService Error", error);
    return {
      code: 500,
      status: "error",
      message: "Failed to fetch attachment",
    };
  }
};
