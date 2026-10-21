import { prisma } from '@/lib/prisma';
import type { JwtPayload } from '@/lib/jwt';
import type { Prisma, ResponseService } from '@/generated/prisma';
import { departmentIncidentScope, departmentService } from '@/domain/department-access.policy';
import { hasValidOperationalAssignment, isMainAdministrator } from '@/domain/permissions.policy';
import { nearbyReviewEnabled, nearbyResponseStartEnabled } from '@/config/nearby-review';
import { nearbyLaneAdmitted, nearbyLaneWaiting } from '@/lib/nearby-review';
import { WorkflowConflict, isWorkflowConflict } from '@/domain/workflow-error.policy';
import { lockOperationalActor, OperationalAuthorizationError } from '@/lib/operational-actor';
import { publishEmergencyEvent } from '@/lib/events';
import { confirmedFalseSanctionsEnabled, lockFalseReportParticipants, reconcileConfirmedFalseSanction } from '@/lib/confirmed-false-sanctions';

export type NearbyDecision = { status: 'ACKNOWLEDGED' | 'REJECTED'; version: number; reason?: string };
export const mayDecideNearbyReview = (actor: JwtPayload, service: ResponseService) => actor.role === 'ADMIN'
  && hasValidOperationalAssignment(actor) && !isMainAdministrator(actor) && departmentService(actor.department) === service;

export async function ListNearbyReviews(actor: JwtPayload, input: { page: number; incidentId?: string; status?: 'PENDING' | 'REJECTED' | 'ACKNOWLEDGED' }) {
  if (!['ADMIN', 'DISPATCHER'].includes(actor.role) || !hasValidOperationalAssignment(actor))
    return { code: 403, message: 'Assigned operational account required' };
  if (!nearbyReviewEnabled()) return { code: 200, data: { enabled: false, items: [], hasMore: false, canDecide: false } };
  const service = departmentService(actor.department);
  const where: Prisma.IncidentNearbyReviewWhereInput = {
    ...(!isMainAdministrator(actor) && { service }),
    ...(input.incidentId && { incidentId: input.incidentId }),
    ...(input.status && { status: input.status }),
    incident: departmentIncidentScope(actor),
  };
  const records = await prisma.incidentNearbyReview.findMany({ where, orderBy: [{ createdAt: 'asc' }, { reviewId: 'asc' }],
    skip: (input.page - 1) * 20, take: 21,
    select: { reviewId: true, incidentId: true, service: true, status: true, reason: true, version: true, createdAt: true, reviewedAt: true,
      ...(nearbyResponseStartEnabled() && { responseStart: { select: { reviewId: true } } }),
      incident: { select: { title: true, status: true, reportedAt: true } } },
  });
  const items = records.slice(0, 20);
  return { code: 200, data: { enabled: true, canDecide: actor.role === 'ADMIN' && !!service && !isMainAdministrator(actor),
    ...(nearbyResponseStartEnabled() && { requiresResponseStart: true }),
    items: nearbyResponseStartEnabled() ? items.map(row => ({ reviewId: row.reviewId, incidentId: row.incidentId,
      service: row.service, status: row.status, reason: row.reason, version: row.version, createdAt: row.createdAt,
      reviewedAt: row.reviewedAt, incident: row.incident, responseStarted: Boolean('responseStart' in row && row.responseStart) })) : items,
    hasMore: records.length > 20 } };
}

// Intake is shared department work, NOT a personal sound/attention receipt.
// Lock ordering is actor/session -> sorted incidents -> decision. Recheck RBAC
// after the lock and compare versions before any state, outbox or audit write.
export async function DecideNearbyReview(reviewId: string, input: NearbyDecision, actor: JwtPayload) {
  if (!nearbyReviewEnabled()) return { code: 409, message: 'Nearby review is not enabled' };
  const service = departmentService(actor.department);
  if (!service || !mayDecideNearbyReview(actor, service)) return { code: 403, message: 'Only the assigned department administrator can decide' };
  const reason = input.reason?.trim() || null;
  if (!['ACKNOWLEDGED', 'REJECTED'].includes(input.status) || !Number.isSafeInteger(input.version) || input.version < 1
    || (input.status === 'REJECTED' && (!reason || reason.length < 10 || reason.length > 500))
    || (reason && reason.length > 500)) return { code: 400, message: 'A current version and a 10–500 character rejection reason are required' };
  try {
    let deactivatedUser: string | null = null;
    const result = await prisma.$transaction(async tx => {
      if (confirmedFalseSanctionsEnabled()) {
        const target = await tx.incidentNearbyReview.findUnique({ where: { reviewId }, select: { incidentId: true } });
        if (target) await lockFalseReportParticipants(tx, target.incidentId, actor);
      }
      const fresh = await lockOperationalActor(tx, actor);
      if (!mayDecideNearbyReview(fresh, service)) throw new OperationalAuthorizationError();
      const initial = await tx.incidentNearbyReview.findUnique({ where: { reviewId }, select: { incidentId: true, parentIncidentId: true, service: true } });
      if (!initial || initial.service !== service) return null;
      for (const id of [initial.incidentId, initial.parentIncidentId].sort())
        await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${id}::uuid FOR UPDATE`;
      const review = await tx.incidentNearbyReview.findFirst({ where: { reviewId, service, incident: departmentIncidentScope(fresh) } });
      if (!review) return null;
      // A retry of the very same decision is harmless; a competing decision is not.
      if (review.status === input.status && review.version === input.version + 1
        && review.reviewedBy === actor.sub && review.reason === reason) return { ...initial, changed: false };
      if (review.status !== 'PENDING' || review.version !== input.version) throw new WorkflowConflict('This nearby report was already reviewed. Refresh before deciding.');
      const incident = await tx.incident.findUniqueOrThrow({ where: { incidentId: review.incidentId }, include: { serviceResponses: true,
        nearbyReviews: nearbyResponseStartEnabled() ? { include: { responseStart: true } } : true } });
      if (!['OPEN', 'ACTIVE', 'RESPONDING'].includes(incident.status) || incident.mergedIntoId || incident.verificationStatus !== 'VERIFIED')
        throw new WorkflowConflict('This report is no longer available for intake review.');
      const response = incident.serviceResponses.find(row => row.service === service);
      if (!response || response.status !== 'RESPONDING') throw new WorkflowConflict('The assigned response changed. Refresh this report.');
      await tx.incidentNearbyReview.update({ where: { reviewId }, data: {
        status: input.status, reason, reviewedBy: actor.sub, reviewedAt: new Date(), version: { increment: 1 },
      } });
      if (input.status === 'REJECTED') await tx.incidentServiceResponse.update({
        where: { incidentId_service: { incidentId: incident.incidentId, service } }, data: { status: 'CANCELLED' },
      });
      const reviews = incident.nearbyReviews.map(row => row.reviewId === reviewId ? { ...row, status: input.status } : row);
      const pending = reviews.some(nearbyLaneWaiting);
      const admitted = incident.serviceResponses.filter(row => !reviews.some(decision => decision.service === row.service && !nearbyLaneAdmitted(decision)));
      const nextStatus = admitted.some(row => row.status === 'RESPONDING') ? 'RESPONDING'
        : pending ? 'OPEN' : admitted.length ? 'RESOLVED' : 'CANCELLED';
      await tx.incident.update({ where: { incidentId: incident.incidentId }, data: {
        status: nextStatus, ...(nextStatus === 'CANCELLED' && { verificationStatus: 'REJECTED' }),
      } });
      if (input.status === 'ACKNOWLEDGED') {
        await tx.incidentAcknowledgement.upsert({ where: { userId_incidentId_scope: { userId: actor.sub, incidentId: incident.incidentId, scope: service } },
          create: { userId: actor.sub, incidentId: incident.incidentId, scope: service, version: response.attentionVersion },
          update: { version: response.attentionVersion, createdAt: new Date() } });
        const mains = await tx.user.findMany({ where: { role: 'ADMIN', department: 'MAIN', isMainAdmin: true, status: 'ACTIVE' }, select: { id: true } });
        for (const main of mains) await tx.incidentAcknowledgement.upsert({
          where: { userId_incidentId_scope: { userId: main.id, incidentId: incident.incidentId, scope: 'MAIN' } },
          create: { userId: main.id, incidentId: incident.incidentId, scope: 'MAIN', version: incident.attentionVersion },
          update: { version: incident.attentionVersion, createdAt: new Date() },
        });
      }
      await tx.auditLog.create({ data: { actorId: actor.sub, action: `NEARBY_REPORT_${input.status}`, entityType: 'Incident', entityId: incident.incidentId,
        metadata: { reviewId, service, parentIncidentId: review.parentIncidentId, reason, previousStatus: 'PENDING', previousVersion: review.version } } });
      deactivatedUser = await reconcileConfirmedFalseSanction(tx, incident.incidentId, actor.sub);
      return { ...initial, changed: true };
    });
    if (!result) return { code: 404, message: 'Nearby report unavailable in your department' };
    if (deactivatedUser) publishEmergencyEvent({ type: 'user.updated', entityId: deactivatedUser });
    if (result.changed) {
      publishEmergencyEvent({ type: 'incident.updated', entityId: result.incidentId });
      publishEmergencyEvent({ type: 'incident.updated', entityId: result.parentIncidentId });
    }
    return { code: 200, message: input.status === 'ACKNOWLEDGED'
      ? nearbyResponseStartEnabled() ? 'Report acknowledged; awaiting an explicit response start' : 'Report admitted to your department queue; not resolved'
      : 'Rejected for your department; evidence retained' };
  } catch (error) {
    if (error instanceof OperationalAuthorizationError) return { code: error.code, message: error.message };
    if (isWorkflowConflict(error)) return { code: 409, message: 'This report or decision changed. Reload the review queue before deciding.' };
    return { code: 503, message: 'Decision not confirmed. Reload and retry safely; reports remain retained.' };
  }
}

/** Separate, durable operational admission. Never infer it from acknowledgment. */
export async function StartNearbyResponse(reviewId: string, version: number, actor: JwtPayload) {
  if (!nearbyResponseStartEnabled()) return { code: 409, message: 'Explicit nearby response start is not enabled' };
  const service = departmentService(actor.department);
  if (!service || !mayDecideNearbyReview(actor, service)) return { code: 403, message: 'Only the assigned department administrator can start response' };
  if (!Number.isSafeInteger(version) || version < 1 || version > 2147483646) return { code: 400, message: 'A current response-start version is required' };
  try {
    const result = await prisma.$transaction(async tx => {
      const fresh = await lockOperationalActor(tx, actor);
      if (!mayDecideNearbyReview(fresh, service)) throw new OperationalAuthorizationError();
      const initial = await tx.incidentNearbyReview.findUnique({ where: { reviewId }, select: { incidentId: true, parentIncidentId: true, service: true } });
      if (!initial || initial.service !== service) return null;
      for (const id of [initial.incidentId, initial.parentIncidentId].sort())
        await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${id}::uuid FOR UPDATE`;
      const review = await tx.incidentNearbyReview.findFirst({ where: { reviewId, service, incident: departmentIncidentScope(fresh) }, include: { responseStart: true } });
      if (!review) return null;
      if (review.responseStart) {
        if (review.responseStart.legacyAdmission || (review.responseStart.startedBy === actor.sub
          && review.responseStart.expectedReviewVersion === version && review.version === version + 1)) return { ...initial, changed: false };
        throw new WorkflowConflict('Another administrator already started this response.');
      }
      if (review.status !== 'ACKNOWLEDGED' || review.version !== version)
        throw new WorkflowConflict('Acknowledge this report and refresh its current version before starting response.');
      const incident = await tx.incident.findUniqueOrThrow({ where: { incidentId: review.incidentId }, include: { serviceResponses: true } });
      if (!['OPEN', 'ACTIVE', 'RESPONDING'].includes(incident.status) || incident.mergedIntoId || incident.verificationStatus !== 'VERIFIED'
        || !incident.serviceResponses.some(row => row.service === service && row.status === 'RESPONDING'))
        throw new WorkflowConflict('This response is no longer available to start.');
      await tx.incidentNearbyResponseStart.create({ data: { reviewId, expectedReviewVersion: version, startedBy: actor.sub } });
      // Preserve the original acknowledgment actor/time/reason, increment only its concurrency fence.
      await tx.incidentNearbyReview.update({ where: { reviewId }, data: { version: { increment: 1 } } });
      await tx.incident.update({ where: { incidentId: review.incidentId }, data: { status: 'RESPONDING' } });
      await tx.auditLog.create({ data: { actorId: actor.sub, action: 'NEARBY_RESPONSE_STARTED', entityType: 'Incident', entityId: review.incidentId,
        metadata: { reviewId, service, parentIncidentId: review.parentIncidentId, expectedReviewVersion: version } } });
      return { ...initial, changed: true };
    });
    if (!result) return { code: 404, message: 'Nearby response unavailable in your department' };
    if (result.changed) {
      publishEmergencyEvent({ type: 'incident.updated', entityId: result.incidentId });
      publishEmergencyEvent({ type: 'incident.updated', entityId: result.parentIncidentId });
    }
    return { code: 200, message: 'Response started; report admitted to your department Responding queue' };
  } catch (error) {
    if (error instanceof OperationalAuthorizationError) return { code: error.code, message: error.message };
    if (isWorkflowConflict(error)) return { code: 409, message: 'The response-start decision changed. Reload before retrying.' };
    return { code: 409, message: 'Response start was not confirmed. Reload before retrying.' };
  }
}
