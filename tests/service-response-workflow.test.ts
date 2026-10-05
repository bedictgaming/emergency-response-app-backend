import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  findIncident: vi.fn(),
  updateService: vi.fn(),
  updateIncident: vi.fn(),
  createAudit: vi.fn(),
  publish: vi.fn(),
  enqueue: vi.fn(), audience: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/events", () => ({ publishEmergencyEvent: mocks.publish }));
vi.mock('@/lib/jobs', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('@/lib/incident-notification-audience', () => ({ incidentNotificationAudience: mocks.audience }));

import { UpdateServiceResponseService } from "@/services/incident/update-service-response-service";

describe("multi-service completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateService.mockResolvedValue({ service: "MEDICAL", status: "RESOLVED" });
    mocks.updateIncident.mockResolvedValue({});
    mocks.createAudit.mockResolvedValue({});
    mocks.audience.mockResolvedValue(['department-admin']);
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
  it('makes identical retries idempotent without advancing attention or creating audit/push work', async () => {
    mocks.findIncident.mockResolvedValue({ status: 'RESPONDING', attentionVersion: 1, serviceResponses: [{ service: 'MEDICAL', status: 'RESPONDING', attentionVersion: 1 }] });
    expect((await UpdateServiceResponseService('incident', 'MEDICAL', 'RESPONDING', { sub: 'admin', role: 'ADMIN', type: 'access', department: 'MEDICAL' })).code).toBe(200);
    expect(mocks.updateService).not.toHaveBeenCalled(); expect(mocks.createAudit).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('atomically advances service/global versions and enqueues only the reopened service', async () => {
    mocks.findIncident.mockResolvedValue({ status: 'RESPONDING', attentionVersion: 3, serviceResponses: [{ service: 'MEDICAL', status: 'RESOLVED', attentionVersion: 2 }, { service: 'FIRE', status: 'RESPONDING', attentionVersion: 1 }] });
    mocks.updateService.mockResolvedValue({ service: 'MEDICAL', status: 'RESPONDING', attentionVersion: 3 });
    expect((await UpdateServiceResponseService('incident', 'MEDICAL', 'RESPONDING', { sub: 'admin', role: 'ADMIN', type: 'access', department: 'MEDICAL' })).code).toBe(200);
    expect(mocks.updateService).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ attentionVersion: { increment: 1 } }) }));
    expect(mocks.updateIncident).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'RESPONDING', attentionVersion: { increment: 1 } } }));
    expect(mocks.audience).toHaveBeenCalledWith(expect.anything(), ['MEDICAL']);
    expect(mocks.enqueue.mock.calls[0][2].data).toMatchObject({ responseService: 'MEDICAL', attentionVersion: '4', serviceAttentionVersion: '3' });
  });
});
