import { IncidentRepository } from "@/repositories/incident.repository";
import { prisma } from "@/lib/prisma";
import { enqueueAssetCleanup } from "@/lib/jobs";
import { WorkflowConflict, isWorkflowConflict } from "@/domain/workflow-error.policy";
import type { JwtPayload } from "@/lib/jwt";
import { isMainAdministrator } from "@/domain/permissions.policy";
import { publishEmergencyEvent } from "@/lib/events";
import { lockOperationalActor, OperationalAuthorizationError } from '@/lib/operational-actor';
import { requireConfirmedFalseReport, validFalseReportVersion, type FalseReportVersion } from '@/domain/false-report-disposition.policy';
import { nearbyReviewEnabled } from '@/config/nearby-review';

const incidentRepository = new IncidentRepository();
export const DeleteIncidentService = async (id: string, actor: JwtPayload, input: { reason: string; confirmation: string; falseReport?: FalseReportVersion }) => {
  try {
    if (!isMainAdministrator(actor)) {
      return { code: 403, status: "error", message: "Only the main administrator can permanently delete an incident" };
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length < 10 || reason.length > 500 || input.confirmation !== "DELETE") return { code: 400, status: "error", message: "A deletion reason and DELETE confirmation are required" };
    if (input.falseReport && !validFalseReportVersion(input.falseReport)) return { code: 400, status: 'error', message: 'Current report and confirmed-review versions are required for early deletion.' };
    const existing = await incidentRepository.findById(id);
    if (!existing) return { code: 404, status: "error", message: "Incident not found" };
    if (!['CLOSED', 'CANCELLED'].includes(existing.status) && !input.falseReport) {
      return { code: 409, status: "error", message: "Close the incident before permanently deleting it" };
    }

    await prisma.$transaction(async (tx) => {
      const fresh = await lockOperationalActor(tx, actor);
      if (!isMainAdministrator(fresh)) throw new OperationalAuthorizationError();
      await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${id}::uuid FOR UPDATE`;
      if (nearbyReviewEnabled() && await tx.incidentNearbyReview.findFirst({ where: {
        OR: [{ incidentId: id }, { parentIncidentId: id }],
      }, select: { reviewId: true } })) throw new WorkflowConflict('This report and its evidence belong to a retained nearby review. Permanent deletion is unavailable.');
      const current = await tx.incident.findUnique({
        where: { incidentId: id },
        include: { attachments: { select: { publicId: true } }, incidentUnits: { select: { unitId: true, status: true } }, tasks: { select: { status: true } }, reviewFlags: true },
      });
      if (!current) throw new WorkflowConflict("Incident was already removed");
      if (input.falseReport) requireConfirmedFalseReport(current, input.falseReport);
      else if (!['CLOSED', 'CANCELLED'].includes(current.status)) throw new WorkflowConflict("Incident status changed; close it before deletion");
      // Physical dispatch is outside this app. Historical statuses belong in
      // the audit tombstone, not an actionable completion gate.
      if (current.tasks.some(task => task.status !== "DONE")) throw new WorkflowConflict("Complete all incident tasks before deletion");

      for (const attachment of current.attachments) {
        if (attachment.publicId) await enqueueAssetCleanup(tx, attachment.publicId);
      }

      await tx.alert.updateMany({ where: { incidentId: id }, data: { incidentId: null } });
      await tx.task.deleteMany({ where: { incidentId: id } });
      await tx.incidentUnit.deleteMany({ where: { incidentId: id } });
      await tx.attachment.deleteMany({ where: { incidentId: id } });
      await tx.incident.delete({ where: { incidentId: id } });
      await tx.auditLog.create({ data: {
        actorId: actor.sub, action: "INCIDENT_DELETED", entityType: "Incident", entityId: id,
        metadata: { title: current.title, status: current.status, reason, ...(input.falseReport && { confirmedFalseDisposition: true, confirmedReviewFlagId: input.falseReport.reviewFlagId }), attachmentCount: current.attachments.length, retiredUnitAssignments: current.incidentUnits.map(item => ({ unitId: item.unitId, status: item.status })), reviewFlags: current.reviewFlags.map(flag => ({ department: flag.department, reason: flag.reason, status: flag.status, reviewNotes: flag.reviewNotes })) },
      } });
    }, { timeout: 20_000 });

    publishEmergencyEvent({ type: "incident.updated", entityId: id });
    return { code: 200, status: "success", message: "Incident deleted successfully" };
  } catch (error) {
    if (error instanceof OperationalAuthorizationError) return { code: error.code, status: 'error', message: error.message };
    if (isWorkflowConflict(error)) {
      return { code: 409, status: "error", message: error instanceof Error ? error.message : "Incident changed concurrently" };
    }
    console.error("DeleteIncidentService failed; refresh before retrying");
    return { code: 500, status: "error", message: "Failed to delete incident" };
  }
};
