import type { Prisma, ResponseService } from '@/generated/prisma';
import { nearbyReviewEnabled, nearbyResponseStartEnabled } from '@/config/nearby-review';
import { WorkflowConflict } from '@/domain/workflow-error.policy';
import { departmentService } from '@/domain/department-access.policy';
import { hasValidOperationalAssignment, isMainAdministrator } from '@/domain/permissions.policy';

export const nearbyLaneAdmitted = (review: { status: string; responseStart?: unknown }) =>
  review.status === 'ACKNOWLEDGED' && (!nearbyResponseStartEnabled() || Boolean(review.responseStart));

export const nearbyLaneWaiting = (review: { status: string; responseStart?: unknown }) =>
  review.status === 'PENDING' || (nearbyResponseStartEnabled() && review.status === 'ACKNOWLEDGED' && !review.responseStart);

export function regularNearbyReviewScope(service?: ResponseService): Prisma.IncidentWhereInput {
  if (!nearbyReviewEnabled()) return {};
  if (nearbyResponseStartEnabled()) {
    const held: Prisma.IncidentNearbyReviewWhereInput = { OR: [
      { status: 'PENDING' }, { status: 'ACKNOWLEDGED', responseStart: { is: null } },
    ] };
    if (service) return { nearbyReviews: { none: { service, ...held } } };
    return { OR: [
      { nearbyReviews: { none: held } },
      ...(['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const).map(service => ({
        serviceResponses: { some: { service, status: { not: 'CANCELLED' as const } } },
        nearbyReviews: { none: { service, OR: [
          { status: { in: ['PENDING', 'REJECTED'] as ('PENDING' | 'REJECTED')[] } },
          { status: 'ACKNOWLEDGED' as const, responseStart: { is: null } },
        ] } },
      })),
    ] };
  }
  if (service) return { nearbyReviews: { none: { service, status: 'PENDING' } } };
  return { OR: [
    { nearbyReviews: { none: { status: 'PENDING' } } },
    ...(['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const).map(service => ({
      serviceResponses: { some: { service, status: { not: 'CANCELLED' as const } } },
      nearbyReviews: { none: { service, status: { in: ['PENDING', 'REJECTED'] as ('PENDING' | 'REJECTED')[] } } },
    })),
  ] };
}

// Call under the incident lock. A blocked service cannot bypass intake through
// general status, task or merge APIs. Never use a client-provided approval.
export async function requireNearbyAdmission(tx: Prisma.TransactionClient, incidentId: string, service?: ResponseService) {
  if (!nearbyReviewEnabled()) return;
  const blocked = await tx.incidentNearbyReview.findFirst({ where: {
    incidentId, ...(service && { service }), ...(nearbyResponseStartEnabled() ? { OR: [
      { status: { in: ['PENDING', 'REJECTED'] as ('PENDING' | 'REJECTED')[] } },
      { status: 'ACKNOWLEDGED' as const, responseStart: { is: null } },
    ] } : { status: { in: ['PENDING', 'REJECTED'] } }),
  }, select: { reviewId: true } });
  if (blocked) throw new WorkflowConflict('This department must review the pending nearby report before response work can proceed.');
}

// For older internal task/general-update signatures carrying actorId only.
// Acquire this BEFORE the incident lock, preserving User -> incident ordering.
export async function nearbyActorService(tx: Prisma.TransactionClient, actorId?: string) {
  if (!nearbyReviewEnabled() || !actorId) return undefined;
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actorId} FOR UPDATE`;
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, department: true, status: true, isMainAdmin: true } });
  if (!actor || actor.status !== 'ACTIVE' || !['ADMIN', 'DISPATCHER'].includes(actor.role) || !hasValidOperationalAssignment(actor))
    throw new WorkflowConflict('Your department access changed. Refresh before changing this report.');
  return isMainAdministrator(actor) ? undefined : departmentService(actor.department);
}

// Safe even on citizen-owned DTOs: no other report IDs, pins or staff identities.
export async function nearbyIntakeSummary(tx: Pick<Prisma.TransactionClient, 'incidentNearbyReview'>, incidentIds: string[]) {
  if (!nearbyReviewEnabled() || !incidentIds.length) return [];
  const records = await tx.incidentNearbyReview.findMany({ where: { incidentId: { in: incidentIds } },
    select: { incidentId: true, service: true, status: true,
      ...(nearbyResponseStartEnabled() && { responseStart: { select: { reviewId: true } } }) } });
  return nearbyResponseStartEnabled() ? records.map(row => ({ incidentId: row.incidentId, service: row.service,
    status: row.status, responseStarted: Boolean('responseStart' in row && row.responseStart) })) : records;
}
