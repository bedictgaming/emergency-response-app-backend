import type { IncidentStatus, Prisma, ResponseService } from '@/generated/prisma';
import { prisma } from '@/lib/prisma';
import { findMatchingNearbyIncident, nearbyIncidentCandidateQuery } from '@/domain/incident-proximity.policy';
import { responseServicesForIncident } from '@/domain/response-services.policy';

type Report = {
  incidentId: string; typeId: string; status: IncidentStatus;
  latitude: unknown; longitude: unknown;
  requestedServices?: ResponseService[]; type?: { typeName: string } | null;
};
type Notice = 'POSSIBLE_DUPLICATE' | 'UNAVAILABLE';

/** Advisory only; never expose another report's identity, evidence or coordinates. */
export async function withNearbyReportNotices<T extends Report>(reports: T[], scope: Prisma.IncidentWhereInput) {
  return Promise.all(reports.map(async (report, index): Promise<T & { nearbyReportWarning?: Notice }> => {
    if (!['OPEN', 'ACTIVE', 'RESPONDING'].includes(report.status)
        || report.latitude == null || report.longitude == null) return report;
    const latitude = Number(report.latitude), longitude = Number(report.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return report;
    // Live pages contain five reports. Cap extra work even for a larger API page.
    if (index >= 5) return { ...report, nearbyReportWarning: 'UNAVAILABLE' };
    try {
      const query = nearbyIncidentCandidateQuery(latitude, longitude);
      const candidates = await prisma.incident.findMany({ ...query,
        where: { AND: [query.where, scope, { incidentId: { not: report.incidentId } }] },
        orderBy: { incidentId: 'asc' }, take: 101,
      });
      const match = findMatchingNearbyIncident(candidates, latitude, longitude, responseServicesForIncident(report), report.typeId);
      if (match) return { ...report, nearbyReportWarning: 'POSSIBLE_DUPLICATE' };
      return candidates.length === 101 ? { ...report, nearbyReportWarning: 'UNAVAILABLE' } : report;
    } catch {
      // A secondary warning lookup must not hide an otherwise available emergency.
      console.warn('Nearby report warning unavailable');
      return { ...report, nearbyReportWarning: 'UNAVAILABLE' };
    }
  }));
}
