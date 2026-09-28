import { IncidentStatus, ResponseService } from "@/generated/prisma";
import { overlappingResponseServices, responseServicesForIncident } from "@/lib/response-services";

export const DUPLICATE_INCIDENT_RADIUS_METERS = 100;
const ACTIVE_STATUSES: IncidentStatus[] = ["OPEN", "ACTIVE", "RESPONDING"];
const GRID_CELL_METERS = 200;
const CORDOVA_LATITUDE_METERS_PER_DEGREE = 111_320;
const CORDOVA_LONGITUDE_METERS_PER_DEGREE = CORDOVA_LATITUDE_METERS_PER_DEGREE * Math.cos(10.25 * Math.PI / 180);
const COORDINATE_STORAGE_EPSILON = 0.000001;

export interface ProximityIncident {
  incidentId: string;
  status: IncidentStatus;
  latitude: unknown;
  longitude: unknown;
}

export interface NearbyIncident extends ProximityIncident {
  distanceMeters: number;
}

const EARTH_RADIUS_METERS = 6_371_000;
const toRadians = (degrees: number) => degrees * Math.PI / 180;

/** A conservative SQL prefilter; the exact haversine check remains authoritative. */
export function nearbyIncidentCandidateQuery(latitude: number, longitude: number) {
  const latitudeDelta = DUPLICATE_INCIDENT_RADIUS_METERS / EARTH_RADIUS_METERS * 180 / Math.PI;
  const furthestLatitude = Math.min(89.999, Math.abs(latitude) + latitudeDelta);
  const longitudeDelta = latitudeDelta / Math.cos(toRadians(furthestLatitude));
  return {
    where: {
      status: { in: ACTIVE_STATUSES },
      latitude: {
        gte: latitude - latitudeDelta - COORDINATE_STORAGE_EPSILON,
        lte: latitude + latitudeDelta + COORDINATE_STORAGE_EPSILON,
      },
      longitude: {
        gte: longitude - longitudeDelta - COORDINATE_STORAGE_EPSILON,
        lte: longitude + longitudeDelta + COORDINATE_STORAGE_EPSILON,
      },
    },
    select: {
      incidentId: true,
      typeId: true,
      status: true,
      latitude: true,
      longitude: true,
      requestedServices: true,
      type: { select: { typeName: true } },
    },
  } as const;
}

export interface DuplicateCandidate extends ProximityIncident {
  typeId: string;
  requestedServices: ResponseService[];
  type: { typeName: string } | null;
}

export function findMatchingNearbyIncident(
  candidates: DuplicateCandidate[],
  latitude: number,
  longitude: number,
  requestedServices: ResponseService[],
  typeId?: string,
): NearbyIncident | undefined {
  const matchingServices = candidates.filter((candidate) => requestedServices.length > 0
    ? overlappingResponseServices(responseServicesForIncident(candidate), requestedServices)
    : candidate.typeId === typeId);
  return findNearestIncidentWithinRadius(matchingServices, latitude, longitude);
}

/**
 * Every pair of Cordova pins within 100 m has grid indices at most one cell
 * apart on each axis. Locking each pin's 3x3 neighborhood makes the lock sets
 * intersect across barangay borders; sorted keys avoid multi-service deadlocks.
 */
export function nearbyIncidentLockKeys(latitude: number, longitude: number, services: string[]): string[] {
  const x = Math.floor(longitude * CORDOVA_LONGITUDE_METERS_PER_DEGREE / GRID_CELL_METERS);
  const y = Math.floor(latitude * CORDOVA_LATITUDE_METERS_PER_DEGREE / GRID_CELL_METERS);
  const keys: string[] = [];
  for (const service of [...new Set(services)].sort()) {
    for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
      for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
        keys.push(`incident-area:${service}:${x + deltaX}:${y + deltaY}`);
      }
    }
  }
  return keys.sort();
}

export function distanceBetweenCoordinatesMeters(
  firstLatitude: number,
  firstLongitude: number,
  secondLatitude: number,
  secondLongitude: number,
): number {
  const latitudeDelta = toRadians(secondLatitude - firstLatitude);
  const longitudeDelta = toRadians(secondLongitude - firstLongitude);
  const firstLatitudeRadians = toRadians(firstLatitude);
  const secondLatitudeRadians = toRadians(secondLatitude);

  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitudeRadians)
      * Math.cos(secondLatitudeRadians)
      * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export function findNearestIncidentWithinRadius(
  incidents: ProximityIncident[],
  latitude: number,
  longitude: number,
  radiusMeters = DUPLICATE_INCIDENT_RADIUS_METERS,
): NearbyIncident | undefined {
  return incidents
    .map((incident) => ({
      ...incident,
      distanceMeters: distanceBetweenCoordinatesMeters(
        latitude,
        longitude,
        Number(incident.latitude),
        Number(incident.longitude),
      ),
    }))
    .filter((incident) => Number.isFinite(incident.distanceMeters) && incident.distanceMeters <= radiusMeters)
    .sort((first, second) => first.distanceMeters - second.distanceMeters)[0];
}
