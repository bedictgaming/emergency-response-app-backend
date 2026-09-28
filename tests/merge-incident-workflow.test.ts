import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), lock: vi.fn(), findIncidents: vi.fn(), taskCount: vi.fn(), dispatchCount: vi.fn(),
  updateIncident: vi.fn(), updateResponses: vi.fn(), createAudit: vi.fn(), publish: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/events", () => ({ publishEmergencyEvent: mocks.publish }));

import { MergeIncidentService } from "@/services/incident/merge-incident-service";

const sourceId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const actor = { sub: "33333333-3333-4333-8333-333333333333", role: "ADMIN", type: "access" as const, department: "MAIN" as const, isMainAdmin: true };

describe("merge workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIncidents.mockResolvedValue([
      { incidentId: sourceId, status: "RESPONDING", mergedIntoId: null, requestedServices: ["FIRE"], type: { typeName: "Fire" } },
      { incidentId: targetId, status: "RESPONDING", mergedIntoId: null, requestedServices: ["FIRE"], type: { typeName: "Fire" } },
    ]);
    mocks.taskCount.mockResolvedValue(0);
    mocks.dispatchCount.mockResolvedValue(0);
    mocks.updateIncident.mockResolvedValue({ incidentId: sourceId, status: "CLOSED" });
    mocks.updateResponses.mockResolvedValue({ count: 1 });
    mocks.createAudit.mockResolvedValue({});
    mocks.transaction.mockImplementation(async callback => callback({
      $queryRaw: mocks.lock,
      incident: { findMany: mocks.findIncidents, update: mocks.updateIncident },
      task: { count: mocks.taskCount },
      incidentUnit: { count: mocks.dispatchCount },
      incidentServiceResponse: { updateMany: mocks.updateResponses },
      auditLog: { create: mocks.createAudit },
    }));
  });

  it("refuses to merge a report with active responder work", async () => {
    mocks.taskCount.mockResolvedValue(1);
    const result = await MergeIncidentService(sourceId, targetId, "Duplicate", actor);
    expect(result.code).toBe(409);
    expect(mocks.updateIncident).not.toHaveBeenCalled();
  });

  it("refuses a merge across different response services", async () => {
    mocks.findIncidents.mockResolvedValueOnce([
      { incidentId: sourceId, status: "RESPONDING", mergedIntoId: null, requestedServices: ["FIRE"], type: { typeName: "Fire" } },
      { incidentId: targetId, status: "RESPONDING", mergedIntoId: null, requestedServices: ["MEDICAL"], type: { typeName: "Medical" } },
    ]);
    const result = await MergeIncidentService(sourceId, targetId, "Not the same service", actor);
    expect(result.code).toBe(409);
    expect(mocks.updateIncident).not.toHaveBeenCalled();
  });

  it("closes a work-free duplicate and supersedes only its response rows", async () => {
    const result = await MergeIncidentService(sourceId, targetId, "Duplicate", actor);
    expect(result.code).toBe(200);
    expect(mocks.updateResponses).toHaveBeenCalledWith(expect.objectContaining({
      where: { incidentId: sourceId, status: { not: "RESOLVED" } },
      data: expect.objectContaining({ status: "RESOLVED", resolvedBy: actor.sub }),
    }));
    expect(mocks.createAudit).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "INCIDENT_MERGED", metadata: { targetIncidentId: targetId, reason: "Duplicate", supersededServices: ["FIRE"] } }),
    }));
    expect(mocks.publish).toHaveBeenCalledTimes(2);
  });
});
