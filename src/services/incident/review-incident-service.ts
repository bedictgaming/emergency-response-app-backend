import { Department, IncidentReviewStatus } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import type { JwtPayload } from "@/lib/jwt";
import { departmentIncidentScope } from "@/lib/department-access";
import { hasValidOperationalAssignment, isMainAdministrator } from "@/lib/permissions";
import { publishEmergencyEvent } from "@/lib/events";
import { WorkflowConflict, isWorkflowConflict } from "@/lib/workflow-error";

export function reviewDepartmentFor(actor: JwtPayload): Department | "ALL" | undefined {
  if (actor.role !== "ADMIN" || !hasValidOperationalAssignment(actor)) return undefined;
  return isMainAdministrator(actor) ? "ALL" : actor.department ?? undefined;
}

export async function FlagIncidentService(id: string, reason: string, actor: JwtPayload) {
  if (!reviewDepartmentFor(actor)) return { code: 403, status: "error", message: "Only an assigned administrator can flag a report" };
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 500) return { code: 400, status: "error", message: "Flag reason must contain 10–500 characters" };
  try {
    const flag = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${id}::uuid FOR UPDATE`;
      const incident = await tx.incident.findFirst({ where: { incidentId: id, ...departmentIncidentScope(actor) }, select: { incidentId: true } });
      if (!incident) return null;
      const department = actor.department!;
      const existing = await tx.incidentReviewFlag.findUnique({ where: { incidentId_department: { incidentId: id, department } } });
      // Retries and simultaneous flags from the same department preserve the first reason.
      if (existing && existing.status !== "DISMISSED") return existing;
      const data = { reason: trimmed, status: IncidentReviewStatus.PENDING, flaggedBy: actor.sub, reviewedBy: null, reviewNotes: null, reviewedAt: null };
      const saved = existing
        ? await tx.incidentReviewFlag.update({ where: { reviewFlagId: existing.reviewFlagId }, data })
        : await tx.incidentReviewFlag.create({ data: { ...data, incidentId: id, department } });
      await tx.auditLog.create({ data: { actorId: actor.sub, action: "INCIDENT_FLAGGED", entityType: "Incident", entityId: id, metadata: { reviewFlagId: saved.reviewFlagId, department, reason: trimmed } } });
      return saved;
    });
    if (!flag) return { code: 403, status: "error", message: "Incident is outside your department or no longer exists" };
    publishEmergencyEvent({ type: "incident.updated", entityId: id });
    return { code: 200, status: "success", data: { flag } };
  } catch (error) {
    if (isWorkflowConflict(error)) return { code: 409, status: "error", message: "Report changed. Refresh before flagging again." };
    console.error("FlagIncidentService failed", error);
    return { code: 500, status: "error", message: "Could not save the review request" };
  }
}

export async function ReviewIncidentFlagService(id: string, flagId: string, input: { status: "CONFIRMED" | "DISMISSED"; reviewNotes: string; expectedUpdatedAt: string }, actor: JwtPayload) {
  if (!isMainAdministrator(actor)) return { code: 403, status: "error", message: "Only the main administrator can review flags" };
  const notes = input.reviewNotes.trim();
  if (notes.length < 10 || notes.length > 500 || !["CONFIRMED", "DISMISSED"].includes(input.status) || Number.isNaN(Date.parse(input.expectedUpdatedAt))) {
    return { code: 400, status: "error", message: "A valid decision, review explanation and record version are required" };
  }
  try {
    const flag = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${id}::uuid FOR UPDATE`;
      const current = await tx.incidentReviewFlag.findUnique({ where: { reviewFlagId: flagId } });
      if (!current || current.incidentId !== id) throw new WorkflowConflict("The review request is no longer available");
      if (current.status !== "PENDING" || current.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new WorkflowConflict("This flag was changed or reviewed. Refresh before deciding.");
      const saved = await tx.incidentReviewFlag.update({ where: { reviewFlagId: flagId }, data: { status: input.status, reviewNotes: notes, reviewedBy: actor.sub, reviewedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: actor.sub, action: "INCIDENT_FLAG_REVIEWED", entityType: "Incident", entityId: id, metadata: { reviewFlagId: flagId, department: current.department, status: input.status, reviewNotes: notes, reason: current.reason } } });
      return saved;
    });
    publishEmergencyEvent({ type: "incident.updated", entityId: id });
    return { code: 200, status: "success", data: { flag } };
  } catch (error) {
    if (isWorkflowConflict(error)) return { code: 409, status: "error", message: error instanceof Error ? error.message : "Report changed" };
    console.error("ReviewIncidentFlagService failed", error);
    return { code: 500, status: "error", message: "Could not save the review decision" };
  }
}

export async function ListIncidentReviewFlagsService(page: number, actor: JwtPayload) {
  if (!isMainAdministrator(actor)) return { code: 403, status: "error", message: "Only the main administrator can read the review queue" };
  try {
    const where = { status: { in: [IncidentReviewStatus.PENDING, IncidentReviewStatus.CONFIRMED] } };
    const limit = 20;
    const [flags, total] = await Promise.all([
      prisma.incidentReviewFlag.findMany({ where, include: { incident: { select: { incidentId: true, title: true, status: true } } }, orderBy: [{ updatedAt: "desc" }, { reviewFlagId: "asc" }], take: limit, skip: (page - 1) * limit }),
      prisma.incidentReviewFlag.count({ where }),
    ]);
    return { code: 200, status: "success", data: { flags, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } };
  } catch (error) {
    console.error("ListIncidentReviewFlagsService failed", error);
    return { code: 500, status: "error", message: "Could not load the report review queue" };
  }
}
