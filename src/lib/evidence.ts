import { ENV } from "@/config/env";

type AttachmentLike = { attachmentId: string; fileUrl?: unknown; publicId?: unknown };

export function protectAttachment<T extends AttachmentLike>(attachment: T) {
  const { publicId: _privateAssetId, ...metadata } = attachment;
  return {
    ...metadata,
    fileUrl: `${ENV.BACKEND_URL}/api/attachments/v1/${attachment.attachmentId}/content`,
  };
}

export function protectIncidentEvidence<T>(incident: T) {
  const value = incident as T & { attachments?: AttachmentLike[] };
  return {
    ...incident,
    ...(Array.isArray(value.attachments) && { attachments: value.attachments.map(protectAttachment) }),
  };
}
