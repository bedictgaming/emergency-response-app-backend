import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findAll: vi.fn(),
  countByStatus: vi.fn(),
  countByServiceStatus: vi.fn(),
  countByResponseService: vi.fn(),
}));

vi.mock("@/repositories/incident.repository", () => ({
  IncidentRepository: class {
    findAll = mocks.findAll;
    countByStatus = mocks.countByStatus;
    countByServiceStatus = mocks.countByServiceStatus;
    countByResponseService = mocks.countByResponseService;
  },
}));

import { GetAllIncidentsService } from "@/services/incident/get-all-incidents-service";

describe("incident monitor list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAll.mockResolvedValue([{ incidentId: "incident-1" }]);
    mocks.countByStatus.mockResolvedValue([
      { status: "ACTIVE", _count: { _all: 2 } },
      { status: "RESPONDING", _count: { _all: 4 } },
      { status: "RESOLVED", _count: { _all: 6 } },
    ]);
    mocks.countByServiceStatus.mockResolvedValue([
      { status: "RESPONDING", _count: { _all: 3 } },
      { status: "RESOLVED", _count: { _all: 5 } },
    ]);
    mocks.countByResponseService.mockResolvedValue([
      { service: "FIRE", _count: { _all: 4 } },
      { service: "MEDICAL", _count: { _all: 3 } },
      { service: "POLICE", _count: { _all: 2 } },
      { service: "HAZARD", _count: { _all: 5 } },
    ]);
  });

  it("skips the count query only when totals are explicitly omitted", async () => {
    const result = await GetAllIncidentsService({ limit: 50, includeTotal: false });
    expect(result.code).toBe(200);
    expect(result.data?.incidents).toHaveLength(1);
    expect(result.data).not.toHaveProperty("pagination");
    expect(mocks.countByStatus).not.toHaveBeenCalled();
    expect(mocks.countByResponseService).not.toHaveBeenCalled();
  });

  it("keeps paginated dashboards and their totals unchanged", async () => {
    const result = await GetAllIncidentsService({ limit: 5, page: 2, includeServiceSummary: true });
    expect(result.data?.pagination).toEqual({ page: 2, limit: 5, total: 12, pages: 3 });
    expect(result.data?.summary).toEqual({
      total: 12,
      active: 2,
      responding: 4,
      resolved: 6,
      services: { fire: 4, medical: 3, police: 2, hazard: 5 },
    });
    expect(mocks.countByStatus).toHaveBeenCalledOnce();
    expect(mocks.countByResponseService).toHaveBeenCalledOnce();
  });

  it("paginates department tabs by the selected service response status", async () => {
    const result = await GetAllIncidentsService({
      limit: 5,
      page: 1,
      responseService: "MEDICAL",
      serviceStatuses: ["RESOLVED"],
    });

    expect(result.data?.pagination).toEqual({ page: 1, limit: 5, total: 5, pages: 1 });
    expect(result.data?.summary).toEqual({ total: 8, active: 0, responding: 3, resolved: 5 });
    expect(mocks.countByServiceStatus).toHaveBeenCalledOnce();
    expect(mocks.countByStatus).not.toHaveBeenCalled();
  });
});
