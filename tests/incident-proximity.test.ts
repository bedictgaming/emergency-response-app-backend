import { describe, expect, it } from "vitest";
import {
  distanceBetweenCoordinatesMeters,
  findMatchingNearbyIncident,
  findNearestIncidentWithinRadius,
  nearbyIncidentCandidateQuery,
  nearbyIncidentLockKeys,
} from "@/lib/incident-proximity";

const origin = { latitude: 10.251, longitude: 123.949 };

function candidate(latitude: number, longitude: number, status: "OPEN" | "ACTIVE" = "ACTIVE") {
  return {
    incidentId: `${latitude}:${longitude}`,
    title: "Emergency",
    status,
    reportedAt: new Date("2026-09-13T01:00:00Z"),
    latitude,
    longitude,
  };
}

describe("incident proximity", () => {
  it("calculates zero distance for identical coordinates", () => {
    expect(distanceBetweenCoordinatesMeters(
      origin.latitude,
      origin.longitude,
      origin.latitude,
      origin.longitude,
    )).toBe(0);
  });

  it("finds the closest incident within 100 meters", () => {
    const nearby = candidate(10.25145, 123.949);
    const farther = candidate(10.2518, 123.949);

    const result = findNearestIncidentWithinRadius([farther, nearby], origin.latitude, origin.longitude);

    expect(result?.incidentId).toBe(nearby.incidentId);
    expect(result?.distanceMeters).toBeGreaterThan(45);
    expect(result?.distanceMeters).toBeLessThan(55);
  });

  it("does not match an incident outside 100 meters", () => {
    const result = findNearestIncidentWithinRadius(
      [candidate(10.252, 123.949)],
      origin.latitude,
      origin.longitude,
    );

    expect(result).toBeUndefined();
  });

  it("prefilters by coordinates and active status, not barangay", () => {
    const query = nearbyIncidentCandidateQuery(origin.latitude, origin.longitude);
    expect(query.where.status.in).toEqual(["OPEN", "ACTIVE", "RESPONDING"]);
    expect(query.where).not.toHaveProperty("barangayId");
    expect(query.where.latitude.gte).toBeLessThan(origin.latitude - 0.0008);
    expect(query.where.latitude.lte).toBeGreaterThan(origin.latitude + 0.0008);
  });

  it("matches an overlapping service across a barangay boundary but not a different service", () => {
    const crossBoundary = {
      ...candidate(10.2513, 123.949),
      typeId: "fire-type",
      requestedServices: [],
      type: { typeName: "Fire" },
    };
    expect(findMatchingNearbyIncident([crossBoundary], origin.latitude, origin.longitude, ["FIRE"])?.incidentId)
      .toBe(crossBoundary.incidentId);
    expect(findMatchingNearbyIncident([crossBoundary], origin.latitude, origin.longitude, ["MEDICAL"]))
      .toBeUndefined();
  });

  it("treats partial multi-service overlap as a duplicate", () => {
    const existing = {
      ...candidate(10.2513, 123.949),
      typeId: "general-type",
      requestedServices: ["HAZARD", "MEDICAL"] as ("HAZARD" | "MEDICAL")[],
      type: { typeName: "General Emergency" },
    };
    expect(findMatchingNearbyIncident([existing], origin.latitude, origin.longitude, ["MEDICAL", "FIRE"]))
      .toBeDefined();
  });

  it("shares a sorted geographic lock across nearby pins and services", () => {
    const first = nearbyIncidentLockKeys(10.251, 123.949, ["MEDICAL", "FIRE"]);
    const second = nearbyIncidentLockKeys(10.25145, 123.949, ["FIRE"]);
    expect(first).toEqual([...first].sort());
    expect(second.some((key) => first.includes(key))).toBe(true);
    expect(nearbyIncidentLockKeys(10.251, 123.949, ["MEDICAL"]).some((key) => second.includes(key)))
      .toBe(false);
  });

  it("shares a lock for sampled pairs within 100 m, including grid edges", () => {
    const offsets = [0, 0.00013, 0.00044, 0.0008];
    for (const latitudeOffset of offsets) {
      for (const longitudeOffset of offsets) {
        const first = nearbyIncidentLockKeys(10.25 + latitudeOffset, 123.95 + longitudeOffset, ["FIRE"]);
        const second = nearbyIncidentLockKeys(10.25 + latitudeOffset + 0.00045, 123.95 + longitudeOffset + 0.00045, ["FIRE"]);
        expect(second.some((key) => first.includes(key))).toBe(true);
      }
    }
  });
});
