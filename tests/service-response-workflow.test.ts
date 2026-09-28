import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  findIncident: vi.fn(),
  updateService: vi.fn(),
  updateIncident: vi.fn(),
  createAudit: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/events", () => ({ publishEmergencyEvent: mocks.publish }));

import { UpdateServiceResponseService } from "@/services/incident/update-service-response-service";

describe("multi-service completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateService.mockResolvedValue({ service: "MEDICAL", status: "RESOLVED" });
    mocks.updateIncident.mockResolvedValue({});
    mocks.createAudit.mockResolvedValue({});
    mocks.transaction.mockImplementation(async callback => callback({
      $queryRaw: mocks.queryRaw,
      incident: { findUnique: mocks.findIncident, update: mocks.updateIncident },
      incidentServiceResponse: { update: mocks.updateService },
      auditLog: { create: mocks.createAudit },
    }));
  });

  it("does not resolve the whole incident while another service is responding", async () => {
    mocks.findIncident.mockResolvedValue({
      status: "RESPONDING",
      serviceResponses: [
        { service: "MEDICAL", status: "RESPONDING" },
        { service: "HAZARD", status: "RESPONDING" },
      ],
    });

    const result = await UpdateServiceResponseService(
      "00000000-0000-0000-0000-000000000001",
      "MEDICAL",
      "RESOLVED",
      { sub: "medic-admin", role: "ADMIN", type: "access", department: "MEDICAL", isMainAdmin: false },
    );

    expect(result.code).toBe(200);
    expect(mocks.updateIncident).not.toHaveBeenCalled();
  });

  it("resolves the incident after the final requested service completes", async () => {
    mocks.findIncident.mockResolvedValue({
      status: "RESPONDING",
      serviceResponses: [
        { service: "MEDICAL", status: "RESPONDING" },
        { service: "HAZARD", status: "RESOLVED" },
      ],
    });

    await UpdateServiceResponseService(
      "00000000-0000-0000-0000-000000000001",
      "MEDICAL",
      "RESOLVED",
      { sub: "medic-admin", role: "ADMIN", type: "access", department: "MEDICAL", isMainAdmin: false },
    );

    expect(mocks.updateIncident).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RESOLVED" } }));
  });

  it("prevents one department from completing another department response", async () => {
    const result = await UpdateServiceResponseService(
      "00000000-0000-0000-0000-000000000001",
      "HAZARD",
      "RESOLVED",
      { sub: "medic-admin", role: "ADMIN", type: "access", department: "MEDICAL", isMainAdmin: false },
    );

    expect(result.code).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects updates to a merged incident's response", async () => {
    mocks.findIncident.mockResolvedValue({
      status: "CLOSED", mergedIntoId: "target-id",
      serviceResponses: [{ service: "MEDICAL", status: "RESPONDING" }],
    });
    const result = await UpdateServiceResponseService(
      "00000000-0000-0000-0000-000000000001",
      "MEDICAL",
      "RESOLVED",
      { sub: "medic-admin", role: "ADMIN", type: "access", department: "MEDICAL", isMainAdmin: false },
    );
    expect(result.code).toBe(409);
    expect(mocks.updateService).not.toHaveBeenCalled();
  });
});
