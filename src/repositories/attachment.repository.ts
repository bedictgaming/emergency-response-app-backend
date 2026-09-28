import { prisma } from "@/lib/prisma";

interface CreateAttachmentData {
  incidentId: string;
  fileName: string;
  fileType: string;
  fileUrl: string;
  publicId: string;
  format: string;
  bytes: number;
  width: number;
  height: number;
  perceptualHash?: string;
  moderationStatus?: string;
  uploadedBy: string;
}

interface AttachmentFilters {
  incidentId?: string;
  uploadedBy?: string;
}

export class AttachmentRepository {
  async findAll(filters?: AttachmentFilters) {
    return await prisma.attachment.findMany({
      where: {
        ...(filters?.incidentId && { incidentId: filters.incidentId }),
        ...(filters?.uploadedBy && { uploadedBy: filters.uploadedBy }),
      },
      include: {
        uploader: {
          select: { id: true, name: true, email: true, role: true },
        },
        incident: {
          select: { incidentId: true, title: true, status: true },
        },
      },
      orderBy: { uploadedAt: "desc" },
    });
  }

  async findById(id: string) {
    return await prisma.attachment.findUnique({
      where: { attachmentId: id },
      include: {
        uploader: {
          select: { id: true, name: true, email: true, role: true },
        },
        incident: {
          select: { incidentId: true, title: true, status: true, severityLevel: true, reportedBy: true },
        },
      },
    });
  }

  async findByIncidentId(incidentId: string) {
    return await prisma.attachment.findMany({
      where: { incidentId },
      include: {
        uploader: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
      orderBy: { uploadedAt: "desc" },
    });
  }

  async create(data: CreateAttachmentData) {
    return await prisma.attachment.create({
      data: {
        incidentId: data.incidentId,
        fileName: data.fileName,
        fileType: data.fileType,
        fileUrl: data.fileUrl,
        publicId: data.publicId,
        format: data.format,
        bytes: data.bytes,
        width: data.width,
        height: data.height,
        perceptualHash: data.perceptualHash,
        moderationStatus: data.moderationStatus,
        verifiedAt: new Date(),
        uploadedBy: data.uploadedBy,
      },
      include: {
        uploader: {
          select: { id: true, name: true, email: true, role: true },
        },
        incident: {
          select: { incidentId: true, title: true, status: true },
        },
      },
    });
  }

  async delete(id: string) {
    return await prisma.attachment.delete({
      where: { attachmentId: id },
    });
  }

  async findIncidentById(incidentId: string) {
    return await prisma.incident.findUnique({
      where: { incidentId },
    });
  }

  async findByPerceptualHash(perceptualHash: string) {
    return prisma.attachment.findFirst({ where: { perceptualHash } });
  }
}
