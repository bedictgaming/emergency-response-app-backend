import type { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { deleteImage } from "@/lib/cloudinary";
import { sendPushNotification } from "@/lib/push";
import { backgroundJobRetryDelayMs, isTransientJobInfrastructureError } from "@/lib/background-job-resilience";
import cloudinary from "@/lib/cloudinary";
import { ENV } from '@/config/env';
import { assertEvidenceScope } from '@/lib/evidence-scope';

export async function enqueueNotification(tx: Prisma.TransactionClient, eventType: string, payload: { title: string; body: string; data?: Record<string, string> }, userIds: string[]) {
  if (userIds.length === 0) return;
  await tx.notificationOutbox.create({ data: { eventType, payload, userIds: [...new Set(userIds)] } });
}

export async function enqueueAssetCleanup(tx: Prisma.TransactionClient, publicId: string) {
  assertEvidenceScope(publicId);
  await tx.assetCleanupJob.upsert({ where: { publicId }, update: { status: "PENDING", nextAttemptAt: new Date() }, create: { publicId } });
}

const retryAt = (attempts: number) => new Date(Date.now() + Math.min(60, 2 ** attempts) * 60_000);
let processing = false;
let infrastructureFailures = 0;
let infrastructureRetryAt = 0;
let outageNoticeWritten = false;

/** Queue uploads never attached to an incident after a 24-hour grace period. */
export async function sweepOrphanedEvidence() {
  if (!ENV.BACKGROUND_JOBS_ENABLED || !ENV.EVIDENCE_DELETION_ENABLED || !ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED) return;
  let cursor: string | undefined;
  const oldestSafeUpload = Date.now() - 24 * 60 * 60 * 1000;
  do {
    const page = await cloudinary.api.resources({
      resource_type: "image", type: "authenticated", prefix: `${ENV.EVIDENCE_NAMESPACE}/`,
      max_results: 500, ...(cursor && { next_cursor: cursor }),
    });
    const candidates = (page.resources as Array<{ public_id: string; created_at: string }>)
      .filter((asset) => asset.public_id.startsWith(`${ENV.EVIDENCE_NAMESPACE}/`)
        && Number.isFinite(Date.parse(asset.created_at))
        && Date.parse(asset.created_at) < oldestSafeUpload);
    if (candidates.length) {
      const referenced = await prisma.attachment.findMany({
        where: { publicId: { in: candidates.map((asset) => asset.public_id) } },
        select: { publicId: true },
      });
      const used = new Set(referenced.map((item) => item.publicId));
      for (const asset of candidates) {
        if (!used.has(asset.public_id)) await prisma.$transaction((tx) => enqueueAssetCleanup(tx, asset.public_id));
      }
    }
    cursor = page.next_cursor;
  } while (cursor);
}

export async function processPendingJobs() {
  if (!ENV.BACKGROUND_JOBS_ENABLED) return;
  if (processing || Date.now() < infrastructureRetryAt) return;
  processing = true;
  try {
    const staleBefore = new Date(Date.now() - 5 * 60_000);
    await Promise.all([
      prisma.notificationOutbox.updateMany({ where: { status: "PROCESSING", updatedAt: { lt: staleBefore } }, data: { status: "FAILED", nextAttemptAt: new Date(), lastError: "Recovered after interrupted worker" } }),
      ...(ENV.EVIDENCE_DELETION_ENABLED ? [prisma.assetCleanupJob.updateMany({ where: { status: "PROCESSING", updatedAt: { lt: staleBefore } }, data: { status: "FAILED", nextAttemptAt: new Date(), lastError: "Recovered after interrupted worker" } })] : []),
    ]);
    const notifications = await prisma.notificationOutbox.findMany({ where: { status: { in: ["PENDING", "FAILED"] }, nextAttemptAt: { lte: new Date() } }, take: 10, orderBy: { createdAt: "asc" } });
    for (const job of notifications) {
      const claimed = await prisma.notificationOutbox.updateMany({ where: { notificationOutboxId: job.notificationOutboxId, status: job.status }, data: { status: "PROCESSING" } });
      if (!claimed.count) continue;
      try {
        const payload = job.payload as { title: string; body: string; data?: Record<string, string> };
        await sendPushNotification({ ...payload, userIds: job.userIds });
        await prisma.notificationOutbox.update({ where: { notificationOutboxId: job.notificationOutboxId }, data: { status: "COMPLETED", completedAt: new Date(), attempts: { increment: 1 }, lastError: null } });
      } catch (error) {
        const attempts = job.attempts + 1;
        await prisma.notificationOutbox.update({ where: { notificationOutboxId: job.notificationOutboxId }, data: { status: "FAILED", attempts, nextAttemptAt: retryAt(attempts), lastError: String(error).slice(0, 1000) } });
      }
    }

    // Disabled cleanup leaves all historical jobs untouched for investigation.
    const cleanups = ENV.EVIDENCE_DELETION_ENABLED
      ? await prisma.assetCleanupJob.findMany({ where: { status: { in: ["PENDING", "FAILED"] }, nextAttemptAt: { lte: new Date() } }, take: 10, orderBy: { createdAt: "asc" } }) : [];
    for (const job of cleanups) {
      const claimed = await prisma.assetCleanupJob.updateMany({ where: { assetCleanupJobId: job.assetCleanupJobId, status: job.status }, data: { status: "PROCESSING" } });
      if (!claimed.count) continue;
      try {
        assertEvidenceScope(job.publicId);
        if (await prisma.attachment.findUnique({ where: { publicId: job.publicId }, select: { attachmentId: true } })) {
          await prisma.assetCleanupJob.update({ where: { assetCleanupJobId: job.assetCleanupJobId }, data: { status: "COMPLETED", completedAt: new Date(), attempts: { increment: 1 }, lastError: "Cleanup skipped because asset is referenced" } });
          continue;
        }
        await deleteImage(job.publicId);
        await prisma.assetCleanupJob.update({ where: { assetCleanupJobId: job.assetCleanupJobId }, data: { status: "COMPLETED", completedAt: new Date(), attempts: { increment: 1 }, lastError: null } });
      } catch (error) {
        const attempts = job.attempts + 1;
        await prisma.assetCleanupJob.update({ where: { assetCleanupJobId: job.assetCleanupJobId }, data: { status: "FAILED", attempts, nextAttemptAt: retryAt(attempts), lastError: String(error).slice(0, 1000) } });
      }
    }

    if (infrastructureFailures > 0) {
      console.info('[background-jobs] Database connection restored; queued work resumed.');
    }
    infrastructureFailures = 0;
    infrastructureRetryAt = 0;
    outageNoticeWritten = false;
  } catch (error) {
    if (!isTransientJobInfrastructureError(error)) throw error;

    infrastructureFailures += 1;
    const retryDelay = backgroundJobRetryDelayMs(infrastructureFailures);
    infrastructureRetryAt = Date.now() + retryDelay;
    if (!outageNoticeWritten) {
      console.warn(`[background-jobs] Database temporarily unavailable; queued work is preserved and will retry automatically in ${Math.round(retryDelay / 1000)} seconds.`);
      outageNoticeWritten = true;
    }
  } finally {
    processing = false;
  }
}
