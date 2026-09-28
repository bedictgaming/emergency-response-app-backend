import { prisma } from "@/lib/prisma";

const MAX_HOURLY_UPLOADS = 10;

export async function consumePhotoUploadAllowance(userId: string, ipAddress?: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
    const count = await tx.auditLog.count({ where: { actorId: userId, action: "PHOTO_UPLOAD_ATTEMPT", createdAt: { gte: cutoff } } });
    if (count >= MAX_HOURLY_UPLOADS) return false;
    await tx.auditLog.create({ data: { actorId: userId, action: "PHOTO_UPLOAD_ATTEMPT", entityType: "EvidenceUpload", ipAddress } });
    return true;
  });
}
