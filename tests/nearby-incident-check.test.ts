import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findType: vi.fn(),
  findBarangay: vi.fn(),
  findIncidents: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    incidentType: { findFirst: mocks.findType },
    barangay: { findFirst: mocks.findBarangay },
    incident: { findMany: mocks.findIncidents },
  },
}));

import { CheckNearbyIncidentService } from "@/services/incident/check-nearby-incident-service";
import { checkNearbyIncidentSchema } from "@/schema/incident/check-nearby-incident.schema";

describe("nearby incident pre-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findType.mockResolvedValue({ typeId: "fire-type" });
    mocks.findBarangay.mockResolvedValue({ barangayId: "gabi" });
    mocks.findIncidents.mockResolvedValue([]);
  });

  it("returns only a privacy-safe nearby summary", async () => {
    mocks.findIncidents.mockResolvedValue([{
      incidentId: "existing",
      title: "House fire",
      status: "ACTIVE",
      reportedAt: new Date("2026-09-13T01:00:00Z"),
      latitude: 10.26205,
      longitude: 123.95805,
      requestedServices: [],
      type: { typeName: "Fire" },
    }]);

    const result = await CheckNearbyIncidentService({
      category: "fire",
      barangayName: "Gabi",
      latitude: 10.262,
      longitude: 123.958,
      requestedServices: [],
      type: { typeName: "Fire" },
    });

    expect(result.data).toMatchObject({
      duplicate: true,
      locationAccepted: true,
      message: expect.stringContaining("already been reported nearby"),
    });
    expect(result.data).not.toHaveProperty("existingIncident");
    expect(JSON.stringify(result.data)).not.toContain("existing");
    expect(mocks.findIncidents.mock.calls[0][0].where).not.toHaveProperty("barangayId");
  });

  it("allows submission when no active incident is nearby", async () => {
    mocks.findIncidents.mockResolvedValue([{
      incidentId: "far-away",
      title: "House fire",
      status: "ACTIVE",
      reportedAt: new Date("2026-09-13T01:00:00Z"),
      latitude: 10.267,
      longitude: 123.958,
    }]);

    const result = await CheckNearbyIncidentService({
      category: "fire",
      barangayName: "Gabi",
      latitude: 10.262,
      longitude: 123.958,
    });

    expect(result.data).toEqual({
      duplicate: false,
      locationAccepted: true,
      barangayName: "Gabi",
    });
  });

  it("returns an inline preflight result for an out-of-scope pin", async () => {
    const result = await CheckNearbyIncidentService({
      category: "fire",
      barangayName: "Gabi",
      latitude: 14.5995,
      longitude: 120.9842,
    });

    expect(result).toMatchObject({
      code: 200,
      status: "success",
      data: {
        duplicate: false,
        locationAccepted: false,
      },
    });
    expect(mocks.findIncidents).not.toHaveBeenCalled();
  });

  it("does not expose another service's nearby incident", async () => {
    mocks.findIncidents.mockResolvedValue([{
      incidentId: "medical-incident",
      typeId: "medical-type",
      status: "ACTIVE",
      latitude: 10.26205,
      longitude: 123.95805,
      requestedServices: ["MEDICAL"],
      type: { typeName: "Medical" },
    }]);
    const result = await CheckNearbyIncidentService({
      category: "fire", barangayName: "Gabi", latitude: 10.262, longitude: 123.958,
    });
    expect(result.data).toMatchObject({ duplicate: false, locationAccepted: true });
  });

  it("checks an active barangay and legacy General incidents even when category has no mapped service", async () => {
    mocks.findType.mockResolvedValue({ typeId: "general-type" });
    mocks.findIncidents.mockResolvedValue([{
      incidentId: "legacy-general",
      typeId: "general-type",
      status: "ACTIVE",
      latitude: 10.26205,
      longitude: 123.95805,
      requestedServices: [],
      type: { typeName: "General Emergency" },
    }]);
    const request = { category: "general", barangayName: "Gabi", latitude: 10.262, longitude: 123.958 };
    const duplicate = await CheckNearbyIncidentService(request);
    expect(duplicate.data).toMatchObject({ duplicate: true, locationAccepted: true });
    expect(mocks.findType).toHaveBeenCalledWith(expect.objectContaining({
      where: { typeName: { contains: "General", mode: "insensitive" } },
    }));

    mocks.findBarangay.mockResolvedValue(null);
    const inactiveBarangay = await CheckNearbyIncidentService(request);
    expect(inactiveBarangay.data).toMatchObject({ duplicate: false, locationAccepted: false });
  });

  it("validates multi-service preflight the same way as incident creation", () => {
    const body = { category: "Other", barangayName: "Gabi", latitude: 10.262, longitude: 123.958 };
    expect(checkNearbyIncidentSchema.safeParse({ body: { ...body, requestedServices: ["FIRE"] } }).success).toBe(false);
    expect(checkNearbyIncidentSchema.safeParse({ body: { ...body, requestedServices: ["FIRE", "MEDICAL"] } }).success).toBe(true);
    expect(checkNearbyIncidentSchema.safeParse({ body: { ...body, category: "Fire", requestedServices: ["FIRE", "MEDICAL"] } }).success).toBe(false);
  });
});
