import { AttachmentRepository } from '@/repositories/attachment.repository';
import { createEvidenceDownloadUrl } from '@/lib/cloudinary';
import { GetAttachmentService } from './get-attachment-service';

const attachments = new AttachmentRepository();

type EvidenceDeliveryResult = {
  code: number;
  status: string;
  message?: string;
  data?: { url: string; expiresInSeconds: number };
};

// The route's department/account boundary and the existing service's ownership
// checks are preserved. Never sign or retrieve storage metadata before them.
export async function GetEvidenceDeliveryService(
  id: string, requesterId: string, requesterRole: string,
): Promise<EvidenceDeliveryResult> {
  const authorized = await GetAttachmentService(id, requesterId, requesterRole);
  if (authorized.code !== 200 || !authorized.data) {
    return { code: authorized.code, status: authorized.status,
      ...('message' in authorized && { message: authorized.message }) };
  }
  const record = await attachments.findStorageMetadata(id);
  if (!record?.publicId || !record.format) {
    return { code: 404, status: 'error', message: 'Evidence asset is unavailable' };
  }
  return { code: 200, status: 'success', data: {
    url: createEvidenceDownloadUrl(record.publicId, record.format),
    expiresInSeconds: 60,
  } };
}
