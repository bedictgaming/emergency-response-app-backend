import { prisma } from '@/lib/prisma';
import { type Prisma } from '@/generated/prisma';
import type { JwtPayload } from '@/lib/jwt';
import { hasValidOperationalAssignment } from '@/domain/permissions.policy';
import { departmentIncidentScope } from '@/domain/department-access.policy';
import { nearbyIncidentCandidateQuery, distanceBetweenCoordinatesMeters, DUPLICATE_INCIDENT_RADIUS_METERS } from '@/domain/incident-proximity.policy';
import { overlappingResponseServices, responseServicesForIncident } from '@/domain/response-services.policy';
import { resolveBarangayFromCoordinates } from '@/lib/barangay-boundaries';
import type { NearbyDetectionInput } from '@/validation/incident/nearby-detection.schema';
import { nearbyReviewEnabled, nearbyResponseStartEnabled } from '@/config/nearby-review';
import { departmentService } from '@/domain/department-access.policy';
import { isMainAdministrator } from '@/domain/permissions.policy';
import { wholeFalseWhere, wholeReportConfirmedFalse } from '@/lib/report-review';

const activeStatuses = ['OPEN', 'ACTIVE', 'RESPONDING'];
const candidateLimit = 200, markerLimit = 50;
const available = { verificationStatus: { not: 'REJECTED' }, mergedIntoId: null,
  NOT: wholeFalseWhere() } satisfies Prisma.IncidentWhereInput;

/** Read-only detection. Citizen responses never contain another incident's identity or coordinates. */
export async function NearbyDetectionService(input: NearbyDetectionInput, actor: JwtPayload) {
  const citizen = actor.role === 'USER';
  if (!hasValidOperationalAssignment(actor) || (citizen ? input.kind !== 'citizen'
    : !['ADMIN', 'DISPATCHER'].includes(actor.role) || input.kind !== 'department')) {
    return { code: 403, message: 'Nearby detection is outside your access' };
  }
  try {
    return await prisma.$transaction(async tx => {
      const scope = citizen ? { reportedBy: { not: actor.sub } } : departmentIncidentScope(actor);
      const anchor = input.kind === 'department' ? await tx.incident.findFirst({
        where: { AND: [{ incidentId: input.incidentId }, scope] },
        select: { incidentId: true, typeId: true, status: true, latitude: true, longitude: true,
          requestedServices: true, type: { select: { typeName: true } }, verificationStatus: true, mergedIntoId: true,
          serviceResponses: { select: { service: true } }, reviewFlags: { select: { status: true, department: true, reviewAuthority: true } } },
      }) : null;
      if (input.kind === 'department' && !anchor) return { code: 403, message: 'Report unavailable in your department' };
      const latitude = input.kind === 'citizen' ? input.latitude : anchor?.latitude == null ? NaN : Number(anchor.latitude);
      const longitude = input.kind === 'citizen' ? input.longitude : anchor?.longitude == null ? NaN : Number(anchor.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
        || !resolveBarangayFromCoordinates('', latitude, longitude)) return { code: 400, message: 'A valid Cordova location is required' };
      const services = input.kind === 'citizen' ? input.services : responseServicesForIncident(anchor!);
      const active = !anchor || (activeStatuses.includes(anchor.status) && anchor.verificationStatus !== 'REJECTED'
        && anchor.mergedIntoId === null && !wholeReportConfirmedFalse(anchor));
      const base = { radiusMeters: DUPLICATE_INCIDENT_RADIUS_METERS, active, ...(!citizen ? { center: { latitude, longitude } } : {}) };
      if (!active) return { code: 200, data: { ...base, nearby: false, complete: true, items: citizen ? undefined : [] } };
      const query = nearbyIncidentCandidateQuery(latitude, longitude);
      const candidates = await tx.incident.findMany({ ...query, where: { AND: [query.where, scope, available,
        ...(anchor ? [{ incidentId: { not: anchor.incidentId } }] : [])] },
        select: { ...query.select, reviewFlags: { where: { status: 'PENDING', ...(!isMainAdministrator(actor) && !citizen && { department: actor.department! }) }, select: { reviewFlagId: true }, take: 1 } },
        orderBy: { incidentId: 'asc' }, take: candidateLimit + 1 });
      const matches = candidates.slice(0, candidateLimit).flatMap(candidate => {
        const distance = distanceBetweenCoordinatesMeters(latitude, longitude, Number(candidate.latitude), Number(candidate.longitude));
        const similar = services.length ? overlappingResponseServices(responseServicesForIncident(candidate), services)
          : candidate.typeId === anchor?.typeId;
        return similar && activeStatuses.includes(candidate.status) && Number.isFinite(distance) && distance <= DUPLICATE_INCIDENT_RADIUS_METERS
          ? [{ incidentId: candidate.incidentId, latitude: Number(candidate.latitude), longitude: Number(candidate.longitude),
            status: candidate.status, services: responseServicesForIncident(candidate), distanceMeters: Math.round(distance),
            ...(!citizen && candidate.reviewFlags.length > 0 && { flaggedForReview: true }) }] : [];
      }).sort((a, b) => a.distanceMeters - b.distanceMeters || a.incidentId.localeCompare(b.incidentId));
      const complete = candidates.length <= candidateLimit && (citizen || matches.length <= markerLimit);
      // A bounded scan cannot claim "none" when it has not checked every candidate.
      const nearby = matches.length ? true : complete ? false : null;
      const pending = !citizen && anchor && nearbyReviewEnabled() ? await tx.incidentNearbyReview.findMany({
        where: { parentIncidentId: anchor.incidentId,
          ...(nearbyResponseStartEnabled() ? { OR: [{ status: 'PENDING' as const }, { status: 'ACKNOWLEDGED' as const, responseStart: { is: null } }] } : { status: 'PENDING' as const }),
          incidentId: { in: matches.slice(0, markerLimit).map(item => item.incidentId) },
          ...(!isMainAdministrator(actor) && { service: departmentService(actor.department) }), incident: scope },
        select: { incidentId: true, ...(nearbyResponseStartEnabled() && { status: true }) },
      }) : undefined;
      const data = citizen ? { ...base, nearby, complete } : { ...base, nearby, complete, items: matches.slice(0, markerLimit),
        ...(pending && { reviewIncidentIds: [...new Set(pending.map(row => row.incidentId))],
          ...(nearbyResponseStartEnabled() && { waitingIncidentIds: [...new Set(pending.filter(row => 'status' in row && row.status === 'ACKNOWLEDGED').map(row => row.incidentId))] }) }) };
      return { code: 200, data };
    }, { isolationLevel: 'RepeatableRead' });
  } catch { return { code: 503, message: 'Nearby detection unavailable. Reports remain unchanged.' }; }
}
