import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  groupBy: vi.fn(),
  findBarangays: vi.fn(),
  findTypes: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    incident: { groupBy: mocks.groupBy },
    barangay: { findMany: mocks.findBarangays },
    incidentType: { findMany: mocks.findTypes },
  },
}));

import { AnalyticsRepository } from "../src/repositories/analytics.repository";
import { getManilaMonthRange } from "../src/lib/manila-calendar";

describe("database-aggregated analytics", () => {
  const repository = new AnalyticsRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findBarangays.mockResolvedValue([
      { barangayId: "one", name: "A", status: "ACTIVE" },
      { barangayId: "two", name: "B", status: "ACTIVE" },
    ]);
    mocks.findTypes.mockResolvedValue([
      { typeId: "fire", typeName: "Fire Outbreak", description: null },
      { typeId: "medical", typeName: "Medical Emergency", description: null },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts scoped barangay incidents without loading incident rows", async () => {
    mocks.groupBy.mockResolvedValue([
      { barangayId: "one", status: "ACTIVE", _count: { _all: 2 } },
      { barangayId: "one", status: "RESOLVED", _count: { _all: 3 } },
    ]);
    const from = new Date("2026-09-01T00:00:00Z");
    const to = new Date("2026-09-20T00:00:00Z");
    const scope = { serviceResponses: { some: { service: "FIRE" } } };

    const result = await repository.getIncidentsByBarangay({ from, to, scope });

    expect(result.totalIncidents).toBe(5);
    expect(result.rankings[0]).toMatchObject({ barangayId: "one", incidentCount: 5, activeCount: 2, resolvedCount: 3 });
    expect(result.rankings[1]).toMatchObject({ barangayId: "two", incidentCount: 0 });
    expect(mocks.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ verificationStatus: 'VERIFIED', AND: [scope], reportedAt: { gte: from, lte: to } }),
    }));
  });

  it("counts incident types using only grouped totals", async () => {
    mocks.groupBy.mockResolvedValue([
      { typeId: "fire", _count: { _all: 4 } },
      { typeId: "medical", _count: { _all: 1 } },
    ]);

    const result = await repository.getIncidentsByType({ barangayId: "one" });

    expect(result.totalIncidents).toBe(5);
    expect(result.topType).toMatchObject({ typeId: "fire", count: 4, percentage: 80 });
    expect(mocks.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ verificationStatus: 'VERIFIED', barangayId: "one" }),
    }));
  });

  it("computes monthly and historical resolution totals from status groups", async () => {
    mocks.groupBy
      .mockResolvedValueOnce([
        { status: "ACTIVE", _count: { _all: 2 } },
        { status: "RESOLVED", _count: { _all: 3 } },
      ])
      .mockResolvedValueOnce([
        { status: "ACTIVE", _count: { _all: 4 } },
        { status: "RESOLVED", _count: { _all: 7 } },
        { status: "CLOSED", _count: { _all: 1 } },
      ]);

    const result = await repository.getResolvedSummary({ month: 9, year: 2026 });

    expect(result).toMatchObject({ totalReportedThisMonth: 5, resolvedThisMonth: 3, activeThisMonth: 2, resolutionRate: 60, totalHistorical: 12, totalResolvedAllTime: 8 });
    expect(mocks.groupBy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        verificationStatus: 'VERIFIED',
        reportedAt: {
          gte: new Date("2026-08-31T16:00:00.000Z"),
          lt: new Date("2026-09-30T16:00:00.000Z"),
        },
      }),
    }));
  });

  it("selects the current month in Manila across a UTC year boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-31T16:30:00.000Z"));
    mocks.groupBy.mockResolvedValue([]);

    const result = await repository.getResolvedSummary();

    expect(result).toMatchObject({ month: 1, year: 2027 });
    expect(mocks.groupBy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        reportedAt: {
          gte: new Date("2026-12-31T16:00:00.000Z"),
          lt: new Date("2027-01-31T16:00:00.000Z"),
        },
      }),
    }));
  });

  it('counts every lifecycle state once and keeps closure separate from verification', async () => {
    const groups = [
      { status: 'OPEN', _count: { _all: 2 } },
      { status: 'ACTIVE', _count: { _all: 3 } },
      { status: 'RESPONDING', _count: { _all: 4 } },
      { status: 'RESOLVED', _count: { _all: 5 } },
      { status: 'CLOSED', _count: { _all: 6 } },
    ];
    mocks.groupBy.mockResolvedValue(groups);
    const scope = { requestedServices: { has: 'MEDICAL' as const } };
    const result = await repository.getResolvedSummary({ month: 10, year: 2026, scope, barangayId: 'one' });
    expect(result).toMatchObject({ totalReportedThisMonth: 20, resolvedThisMonth: 11,
      activeThisMonth: 9, resolutionRate: 55, totalHistorical: 20, totalResolvedAllTime: 11 });
    for (const [args] of mocks.groupBy.mock.calls) {
      expect(args.where).toMatchObject({ verificationStatus: 'VERIFIED', AND: [scope], barangayId: 'one' });
    }
    expect(mocks.groupBy.mock.calls[1][0].where).not.toHaveProperty('reportedAt');
  });

  it('keeps past verified records when the new month is empty', async () => {
    mocks.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { status: 'RESOLVED', _count: { _all: 13 } },
    ]);
    expect(await repository.getResolvedSummary({ month: 10, year: 2026 })).toMatchObject({
      totalReportedThisMonth: 0, resolvedThisMonth: 0, activeThisMonth: 0,
      resolutionRate: 0, totalHistorical: 13, totalResolvedAllTime: 13,
    });
  });

  it("keeps Manila month ranges half-open across February in a leap year", () => {
    expect(getManilaMonthRange(2, 2028)).toEqual({
      start: new Date("2028-01-31T16:00:00.000Z"),
      end: new Date("2028-02-29T16:00:00.000Z"),
    });
  });
});
