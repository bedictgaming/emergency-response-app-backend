import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findIncident: vi.fn(), findUnit: vi.fn(), findDispatch: vi.fn() }));
vi.mock("@/repositories/incident-unit.repository", () => ({
  IncidentUnitRepository: class {
    findIncidentById = mocks.findIncident;
    findUnitById = mocks.findUnit;
    findByIncidentAndUnit = mocks.findDispatch;
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: vi.fn() } }));
vi.mock("@/lib/events", () => ({ publishEmergencyEvent: vi.fn() }));
vi.mock("@/lib/jobs", () => ({ enqueueNotification: vi.fn() }));

import { DispatchUnitService } from "@/services/incident-unit/dispatch-unit-service";

describe("department-safe dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIncident.mockResolvedValue({ title: "Collision", status: "RESPONDING", verificationStatus: "VERIFIED" });
    mocks.findUnit.mockResolvedValue({ unitId: "unit", unitName: "Ambulance 1", unitType: "EMS Ambulance", status: "AVAILABLE" });
    mocks.findDispatch.mockResolvedValue(null);
  });

  it("rejects dispatching another department's unit", async () => {
    const result = await DispatchUnitService(
      "incident",
      { unitId: "unit" },
      { sub: "fire-admin", role: "ADMIN", type: "access", department: "FIRE", isMainAdmin: false },
    );
    expect(result).toMatchObject({ code: 403 });
  });
});
