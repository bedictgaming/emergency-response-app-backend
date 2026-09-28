import { AttachmentRepository } from "@/repositories/attachment.repository";
import { CreateAttachmentInput } from "@/schema/attachment/create-attachment.schema";
import { verifyUploadedAsset } from "@/lib/cloudinary";
import { prisma } from "@/lib/prisma";
import { WorkflowConflict, isWorkflowConflict } from "@/lib/workflow-error";
import { enqueueAssetCleanup } from "@/lib/jobs";
import { protectAttachment } from "@/lib/evidence";

const attachmentRepository = new AttachmentRepository();

export const CreateAttachmentService = async (
  incidentId: string,
  data: CreateAttachmentInput,
  uploadedBy: string
) => {
  let uploadedPublicId: string | undefined;
  let persisted = false;
  try {
    // 1. Verify incident exists
    const incident = await attachmentRepository.findIncidentById(incidentId);
    if (!incident) {
      return { code: 404, status: "error", message: "Incident not found" };
    }

    // 2. Prevent uploading to CLOSED incidents
    if (incident.status === "CLOSED") {
      return {
        code: 400,
        status: "error",
        message: "Cannot add attachments to a CLOSED incident",
      };
    }

    const asset = await verifyUploadedAsset(data.publicId, uploadedBy);
    uploadedPublicId = asset.publicId;
    if (asset.moderationStatus === "rejected") {
      return { code: 422, status: "error", message: "Image did not pass content moderation" };
    }
    if (asset.phash && await attachmentRepository.findByPerceptualHash(asset.phash)) {
      return { code: 409, status: "error", message: "This image was already used as incident evidence" };
    }

    const attachment = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${incidentId}::uuid FOR UPDATE`;
      const current = await tx.incident.findUniqueOrThrow({ where: { incidentId } });
      if (current.status === "CLOSED") throw new WorkflowConflict("Incident has closed");
      if (asset.phash) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${asset.phash}, 0))`;
        if (await tx.attachment.findFirst({ where: { perceptualHash: asset.phash } })) throw new WorkflowConflict("This image was already used as evidence");
      }
      const created = await tx.attachment.create({ data: {
      incidentId,
      fileName: data.fileName,
      fileType: `image/${asset.format}`,
      fileUrl: asset.url,
      publicId: asset.publicId,
      format: asset.format,
      bytes: asset.bytes,
      width: asset.width,
      height: asset.height,
      perceptualHash: asset.phash,
      moderationStatus: asset.moderationStatus,
      uploadedBy,
      verifiedAt: new Date(),
      } });
      await tx.auditLog.create({ data: { actorId: uploadedBy, action: "EVIDENCE_ADDED", entityType: "Attachment", entityId: created.attachmentId } });
      return created;
    });
    persisted = true;

    return {
      code: 201,
      status: "success",
      message: "Attachment uploaded successfully",
      data: { attachment: protectAttachment(attachment) },
    };
  } catch (error) {
    if (isWorkflowConflict(error)) return { code: 409, status: "error", message: error instanceof WorkflowConflict ? error.message : "Evidence changed concurrently. Refresh and retry." };
    console.error("CreateAttachmentService Error", error);
    return {
      code: 500,
      status: "error",
      message: "Failed to create attachment record",
    };
  } finally {
    if (uploadedPublicId && !persisted) {
      try {
        const referenced = await prisma.attachment.findUnique({ where: { publicId: uploadedPublicId }, select: { attachmentId: true } });
        if (!referenced) await prisma.$transaction((tx) => enqueueAssetCleanup(tx, uploadedPublicId!));
      } catch (error) {
        console.error("Unable to enqueue rejected evidence cleanup", error);
      }
    }
  }
};
