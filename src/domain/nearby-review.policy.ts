import type { ResponseService } from '@/generated/prisma';
import { distanceBetweenCoordinatesMeters } from '@/domain/incident-proximity.policy';
import { responseServicesForIncident } from '@/domain/response-services.policy';

type Candidate = { incidentId: string; reportedAt: Date; latitude: unknown; longitude: unknown;
  requestedServices: ResponseService[]; type: { typeName: string } | null;
  nearbyReviews: Array<{ service: ResponseService; status: string; responseStart?: unknown }>;
  serviceResponses: Array<{ service: ResponseService; status: string }> };

// Receipt/creation order, not closest distance. One stable original per service;
// pending/rejected reports cannot become an original for that service.
export function selectNearbyParents(candidates: Candidate[], latitude: number, longitude: number, services: ResponseService[], requireResponseStart = false) {
  const ordered = [...candidates].filter(item => distanceBetweenCoordinatesMeters(latitude, longitude,
    Number(item.latitude), Number(item.longitude)) <= 100)
    .sort((a, b) => a.reportedAt.getTime() - b.reportedAt.getTime() || a.incidentId.localeCompare(b.incidentId));
  return services.flatMap(service => {
    const parent = ordered.find(item => responseServicesForIncident(item).includes(service)
      && !item.nearbyReviews.some(review => review.service === service
        && (review.status !== 'ACKNOWLEDGED' || (requireResponseStart && !review.responseStart)))
      && !item.serviceResponses.some(response => response.service === service && response.status !== 'RESPONDING'));
    return parent ? [{ service, parentIncidentId: parent.incidentId }] : [];
  });
}
