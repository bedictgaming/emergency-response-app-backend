import { AttachmentRepository } from "@/repositories/attachment.repository";
import { protectAttachment } from "@/lib/evidence";

const attachmentRepository = new AttachmentRepository();

export const GetIncidentAttachmentsService = async (incidentId: string) => {
  try {
    const incident = await attachmentRepository.findIncidentById(incidentId);
    if (!incident) {
      return { code: 404, status: "error", message: "Incident not found" };
    }

    const attachments = await attachmentRepository.findByIncidentId(incidentId);

    return {
      code: 200,
      status: "success",
      data: { attachments: attachments.map(protectAttachment) },
    };
  } catch (error) {
    console.error("GetIncidentAttachmentsService Error", error);
    return {
      code: 500,
      status: "error",
      message: "Failed to fetch attachments for incident",
    };
  }
};
