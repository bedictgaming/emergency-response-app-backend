import { Department, IncidentReviewStatus } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import type { JwtPayload } from "@/lib/jwt";
import { departmentIncidentScope } from "@/domain/department-access.policy";
import { hasValidOperationalAssignment, isMainAdministrator } from "@/domain/permissions.policy";
import { publishEmergencyEvent } from "@/lib/events";
import { WorkflowConflict, isWorkflowConflict } from "@/domain/workflow-error.policy";
import { lockOperationalActor, OperationalAuthorizationError } from '@/lib/operational-actor';
import { requireNearbyAdmission } from '@/lib/nearby-review';
import { departmentService } from '@/domain/department-access.policy';
import { lockFalseReportParticipants, reconcileConfirmedFalseSanction } from '@/lib/confirmed-false-sanctions';
import { nearbyResponseStartEnabled } from '@/config/nearby-review';

export function reviewDepartmentFor(actor: JwtPayload): Department | "ALL" | undefined {
  if (actor.role !== "ADMIN" || !hasValidOperationalAssignment(actor)) return undefined;
  return isMainAdministrator(actor) ? "ALL" : actor.department ?? undefined;
}

export async function FlagIncidentService(id: string, reason: string, actor: JwtPayload) {
  return saveSuspicionFlag({ kind: 'ordinary', id }, reason, actor);
}

export async function FlagNearbyReview(reviewId: string, version: number, reason: string, actor: JwtPayload) {
  if (!nearbyResponseStartEnabled()) return { code: 409, status: 'error', message: 'Nearby intake flagging is not enabled' };
  if (!Number.isSafeInteger(version) || version < 1 || version > 2147483646) return { code: 400, status: 'error', message: 'Current nearby review version required' };
  if (!reviewDepartmentFor(actor) || isMainAdministrator(actor)) return { code: 403, status: 'error', message: 'Only the assigned department administrator can flag nearby intake' };
  return saveSuspicionFlag({ kind: 'nearby', reviewId, version }, reason, actor);
}

type FlagTarget = { kind: 'ordinary'; id: string } | { kind: 'nearby'; reviewId: string; version: number };
async function saveSuspicionFlag(target: FlagTarget, reason: string, actor: JwtPayload) {
  if (!reviewDepartmentFor(actor)) return { code: 403, status: "error", message: "Only an assigned administrator can flag a report" };
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 500) return { code: 400, status: "error", message: "Flag reason must contain 10–500 characters" };
  try {
    let affectedIncidentId: string | undefined;
    const flag = await prisma.$transaction(async tx => {
      const fresh = await lockOperationalActor(tx, actor);
      if (!reviewDepartmentFor(fresh)) throw new OperationalAuthorizationError();
      let id: string;
      if (target.kind === 'nearby') {
        if (!nearbyResponseStartEnabled() || isMainAdministrator(fresh)) throw new OperationalAuthorizationError();
        const initial = await tx.incidentNearbyReview.findUnique({ where: { reviewId: target.reviewId }, select: { incidentId: true, parentIncidentId: true, service: true } });
        if (!initial || initial.service !== departmentService(fresh.department)) return null;
        for (const lockedId of [initial.incidentId, initial.parentIncidentId].sort())
          await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${lockedId}::uuid FOR UPDATE`;
        const review = await tx.incidentNearbyReview.findFirst({ where: { reviewId: target.reviewId, service: initial.service,
          incident: departmentIncidentScope(fresh) }, include: { responseStart: true } });
        if (!review) return null;
        if (review.version !== target.version || !['PENDING', 'ACKNOWLEDGED'].includes(review.status) || review.responseStart)
          throw new WorkflowConflict('Nearby intake changed. Reload before flagging.');
        id = review.incidentId;
        // This exception permits suspicion/audit only, never operational
        // admission. Ordinary flag/task/status APIs keep their admission gate.
      } else {
        id = target.id;
        await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${id}::uuid FOR UPDATE`;
        await requireNearbyAdmission(tx, id, departmentService(fresh.department));
      }
      const incident = await tx.incident.findFirst({ where: { incidentId: id, ...departmentIncidentScope(fresh) }, select: { incidentId: true, status: true } });
      if (!incident) return null;
      if (incident.status === 'CANCELLED') return false;
      if (target.kind === 'nearby' && !['OPEN', 'ACTIVE', 'RESPONDING'].includes(incident.status)) throw new WorkflowConflict('Nearby intake is no longer active.');
      affectedIncidentId = id;
      const department = fresh.department!;
      const existing = await tx.incidentReviewFlag.findUnique({ where: { incidentId_department: { incidentId: id, department } } });
      // Retries and simultaneous flags from the same department preserve the first reason.
      if (existing && existing.status !== "DISMISSED") return existing;
      const data = { reason: trimmed, status: IncidentReviewStatus.PENDING, flaggedBy: actor.sub, reviewedBy: null, reviewNotes: null, reviewedAt: null };
      const saved = existing
        ? await tx.incidentReviewFlag.update({ where: { reviewFlagId: existing.reviewFlagId }, data })
        : await tx.incidentReviewFlag.create({ data: { ...data, incidentId: id, department } });
      await tx.auditLog.create({ data: { actorId: actor.sub, action: "INCIDENT_FLAGGED", entityType: "Incident", entityId: id, metadata: { reviewFlagId: saved.reviewFlagId, department, reason: trimmed,
        ...(target.kind === 'nearby' && { nearbyReviewId: target.reviewId, expectedReviewVersion: target.version }) } } });
      return saved;
    });
    if (flag === false) return { code: 409, status: 'error', message: 'This report is cancelled. Review its retained history instead of flagging it again.' };
    if (!flag) return { code: 403, status: "error", message: "Incident is outside your department or no longer exists" };
    publishEmergencyEvent({ type: "incident.updated", entityId: affectedIncidentId! });
    return { code: 200, status: "success", data: { flag } };
  } catch (error) {
    if (error instanceof OperationalAuthorizationError) return { code: error.code, status: 'error', message: error.message };
    if (isWorkflowConflict(error)) return { code: 409, status: "error", message: "Report changed. Refresh before flagging again." };
    console.error("FlagIncidentService failed", error);
    return { code: 500, status: "error", message: "Could not save the review request" };
  }
}

export async function ReviewIncidentFlagService(id: string, flagId: string, input: { status: "CONFIRMED" | "DISMISSED"; reviewNotes: string; expectedUpdatedAt: string }, actor: JwtPayload) {
  return saveReviewDecision(id, flagId, input, actor, false);
}

export async function CorrectIncidentFlagService(id: string, flagId: string, input: { reviewNotes: string; expectedUpdatedAt: string }, actor: JwtPayload) {
  return saveReviewDecision(id, flagId, { ...input, status: 'DISMISSED' }, actor, true);
}

async function saveReviewDecision(id: string, flagId: string, input: { status: "CONFIRMED" | "DISMISSED"; reviewNotes: string; expectedUpdatedAt: string }, actor: JwtPayload, correction: boolean) {
  if (!isMainAdministrator(actor)) return { code: 403, status: "error", message: "Only the main administrator can review flags" };
  const notes = input.reviewNotes.trim();
  if (notes.length < 10 || notes.length > 500 || !["CONFIRMED", "DISMISSED"].includes(input.status) || Number.isNaN(Date.parse(input.expectedUpdatedAt))) {
    return { code: 400, status: "error", message: "A valid decision, review explanation and record version are required" };
  }
  try {
    let deactivatedUser: string | null = null;
    const flag = await prisma.$transaction(async tx => {
      await lockFalseReportParticipants(tx, id, actor);
      const fresh = await lockOperationalActor(tx, actor);
      if (!isMainAdministrator(fresh)) throw new OperationalAuthorizationError();
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${id}::uuid FOR UPDATE`;
      const current = await tx.incidentReviewFlag.findUnique({ where: { reviewFlagId: flagId } });
      if (!current || current.incidentId !== id) throw new WorkflowConflict("The review request is no longer available");
      const expectedStatus = correction ? 'CONFIRMED' : 'PENDING';
      if (current.status !== expectedStatus || current.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new WorkflowConflict("This flag was changed or reviewed. Refresh before deciding.");
      const saved = await tx.incidentReviewFlag.update({ where: { reviewFlagId: flagId }, data: { status: input.status, reviewNotes: notes, reviewedBy: actor.sub, reviewedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: actor.sub, action: correction ? 'INCIDENT_FLAG_CORRECTED' : "INCIDENT_FLAG_REVIEWED", entityType: "Incident", entityId: id, metadata: {
        reviewFlagId: flagId, department: current.department, status: input.status, reviewNotes: notes, reason: current.reason,
        previousStatus: current.status, previousReviewNotes: current.reviewNotes,
        previousReviewedBy: current.reviewedBy, previousReviewedAt: current.reviewedAt?.toISOString() ?? null,
      } } });
      deactivatedUser = await reconcileConfirmedFalseSanction(tx, id, actor.sub);
      return saved;
    });
    if (deactivatedUser) publishEmergencyEvent({ type: 'user.updated', entityId: deactivatedUser });
    publishEmergencyEvent({ type: "incident.updated", entityId: id });
    return { code: 200, status: "success", data: { flag } };
  } catch (error) {
    if (error instanceof OperationalAuthorizationError) return { code: error.code, status: 'error', message: error.message };
    if (isWorkflowConflict(error)) return { code: 409, status: "error", message: error instanceof Error ? error.message : "Report changed" };
    console.error("ReviewIncidentFlagService failed", error);
    return { code: 500, status: "error", message: "Could not save the review decision" };
  }
}

export async function ListIncidentReviewFlagsService(page: number, actor: JwtPayload) {
  if (!isMainAdministrator(actor)) return { code: 403, status: "error", message: "Only the main administrator can read the review queue" };
  try {
    const where = { status: { in: [IncidentReviewStatus.PENDING, IncidentReviewStatus.CONFIRMED] }, incident: { status: { not: 'CANCELLED' as const } } };
    const limit = 20;
    const [flags, total] = await Promise.all([
      // Enum order is PENDING, CONFIRMED, DISMISSED; oldest pending first.
      prisma.incidentReviewFlag.findMany({ where, include: { incident: { select: { incidentId: true, title: true, status: true } } }, orderBy: [{ status: 'asc' }, { updatedAt: 'asc' }, { reviewFlagId: "asc" }], take: limit, skip: (page - 1) * limit }),
      prisma.incidentReviewFlag.count({ where }),
    ]);
    return { code: 200, status: "success", data: { flags, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } };
  } catch (error) {
    console.error("ListIncidentReviewFlagsService failed", error);
    return { code: 500, status: "error", message: "Could not load the report review queue" };
  }
}
