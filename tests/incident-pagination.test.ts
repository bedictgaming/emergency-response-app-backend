import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), serviceGroupBy: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    incident: { findMany: mocks.findMany, count: mocks.count, groupBy: mocks.groupBy },
    incidentServiceResponse: { groupBy: mocks.serviceGroupBy },
  },
}));

import { IncidentRepository } from "@/repositories/incident.repository";

describe("incident list data minimization", () => {
  it('applies the same bounded search and half-open period to list and grouped totals without losing scope', async () => {
    const scope = { reportedBy: 'citizen' };
    const filters = { scope, search: 'older report', typeName: 'Fire Outbreak', historyFrom: new Date('2026-09-30T16:00:00Z'), historyBefore: new Date('2026-10-31T16:00:00Z'), page: 2, limit: 50, includeUnits: true };
    const repository = new IncidentRepository(); await repository.findAll(filters); await repository.countByStatus(filters);
    const list = mocks.findMany.mock.calls[0][0];
    expect(list.skip).toBe(50); expect(list.take).toBe(50);
    expect(list.orderBy).toEqual([{ reportedAt: 'desc' }, { incidentId: 'desc' }]);
    expect(list.where.AND[0]).toEqual(scope);
    expect(list.where.AND[1]).toMatchObject({ OR: expect.any(Array), reportedAt: { gte: filters.historyFrom, lt: filters.historyBefore } });
    expect(mocks.groupBy.mock.calls[0][0].where.AND).toEqual(list.where.AND);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
  });

  it("paginates and omits attachment rows by default", async () => {
    await new IncidentRepository().findAll({ page: 2, limit: 10 });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 10,
      take: 10,
      include: expect.objectContaining({ attachments: false, incidentUnits: false }),
    }));
  });

  it("filters grouped dashboard tabs before pagination", async () => {
    await new IncidentRepository().findAll({
      page: 2,
      limit: 5,
      statuses: ["OPEN", "ACTIVE"],
    });

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["OPEN", "ACTIVE"] } }),
      skip: 5,
      take: 5,
    }));
  });

  it("filters department tabs by their own service response before pagination", async () => {
    await new IncidentRepository().findAll({
      responseService: "MEDICAL",
      serviceStatuses: ["RESOLVED"],
      page: 1,
      limit: 5,
    });

    expect(mocks.findMany.mock.calls[0][0].where.serviceResponses).toEqual({
      some: { service: "MEDICAL", status: { in: ["RESOLVED"] } },
    });
  });

  it("returns at most one attachment metadata row when requested", async () => {
    await new IncidentRepository().findAll({ includeAttachments: true });
    expect(mocks.findMany.mock.calls[0][0].include.attachments).toEqual({
      orderBy: { uploadedAt: "desc" },
      take: 1,
    });
  });

  it("loads dispatched units only for dashboards that render them", async () => {
    await new IncidentRepository().findAll({ includeUnits: true });
    expect(mocks.findMany.mock.calls[0][0].include.incidentUnits).toEqual({
      include: { unit: true },
    });
  });

  it("keeps verified aggregates scoped and independent of tab and page", async () => {
    const scope = { AND: [{ reportedBy: "citizen" }, { verificationStatus: "VERIFIED" as const }] };
    const repository = new IncidentRepository();
    const filters = { scope, statuses: ["RESOLVED" as const], page: 3, limit: 5 };
    await repository.countByStatus(filters);
    await repository.countByResponseService(filters);
    expect(mocks.groupBy).toHaveBeenCalledWith({
      by: ["status"], where: { AND: [scope] }, _count: { _all: true },
    });
    expect(mocks.serviceGroupBy).toHaveBeenCalledWith({
      by: ["service"], where: { incident: { is: { AND: [scope] } } }, _count: { _all: true },
    });
  });
});
