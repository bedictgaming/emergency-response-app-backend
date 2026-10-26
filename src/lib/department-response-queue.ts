import type { Prisma, ResponseService } from '@/generated/prisma';
import { nearbyResponseStartEnabled } from '@/config/nearby-review';

const services = ['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const;

// A normal lane enters the department's shared queue after a server-authorized
// acknowledgement. A nearby B must instead have its own explicit start receipt;
// the acknowledgement created by its review cannot substitute for that start.
const admittedLane = (service: ResponseService): Prisma.IncidentWhereInput => ({ OR: [
  { nearbyReviews: { some: { service, status: 'ACKNOWLEDGED', responseStart: { isNot: null } } } },
  { nearbyReviews: { none: { service } }, acknowledgements: { some: { scope: service } } },
] });

/** List/count presentation only, never authorization, dispatch or resolution.
 * Existing receipts remain admission evidence after account transfer/revocation
 * or a later attention version. The separate versioned alert still resurfaces
 * reopened work; neither an operator's new session nor Main's receipt admits it.
 * Preserve terminal history and legacy reports without service-response rows.
 */
export function departmentResponseQueueScope(service?: ResponseService): Prisma.IncidentWhereInput {
  if (!nearbyResponseStartEnabled()) return {};
  return { OR: [
    { status: { not: 'RESPONDING' } },
    { serviceResponses: { none: { ...(service && { service }), status: 'RESPONDING' } } },
    ...(service ? [admittedLane(service)] : services.map((lane): Prisma.IncidentWhereInput => ({
      AND: [{ serviceResponses: { some: { service: lane, status: 'RESPONDING' } } }, admittedLane(lane)],
    }))),
  ] };
}
