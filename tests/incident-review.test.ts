import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), findMany: vi.fn(), count: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction, incidentReviewFlag: { findMany: mocks.findMany, count: mocks.count } } }));
vi.mock("@/lib/events", () => ({ publishEmergencyEvent: mocks.publish }));
import { CorrectIncidentFlagService, FlagIncidentService, ListIncidentReviewFlagsService, ReviewIncidentFlagService, reviewDepartmentFor } from "@/services/incident/review-incident-service";
import { operationalUserMock } from './helpers/operational-account';

const main = { sub: "main", sessionId: 'session', role: "ADMIN", type: "access", department: "MAIN", isMainAdmin: true } as const;
const fire = { ...main, sub: "fire", department: "FIRE", isMainAdmin: false } as const;
const pending = { reviewFlagId: "flag", incidentId: "incident", department: "FIRE", status: "PENDING", reason: "Caller confirmed this was a test", updatedAt: new Date("2026-09-30T00:00:00.000Z") };
const input = { status: "CONFIRMED", reviewNotes: "Contacted the reporter and confirmed a false report", expectedUpdatedAt: pending.updatedAt.toISOString() } as const;

describe("incident review workflow", () => {
  beforeEach(() => vi.clearAllMocks());
  it("exposes review data only to valid admins", () => {
    expect(reviewDepartmentFor(main)).toBe("ALL");
    expect(reviewDepartmentFor(fire)).toBe("FIRE");
    for (const actor of [{ ...main, role: "USER" }, { ...main, role: "DISPATCHER" }, { ...fire, isMainAdmin: true }, { ...main, isMainAdmin: false }]) expect(reviewDepartmentFor(actor)).toBeUndefined();
  });
  it("denies citizens and dispatchers before saving a flag", async () => {
    for (const role of ["USER", "DISPATCHER"]) expect((await FlagIncidentService("incident", pending.reason, { ...fire, role })).code).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("does not flag an incident outside the department or change incident state", async () => {
    const tx = { $queryRaw: vi.fn(), user: operationalUserMock(fire), incident: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() } };
    mocks.transaction.mockImplementation(callback => callback(tx));
    expect((await FlagIncidentService("incident", pending.reason, fire)).code).toBe(403);
    expect(tx.incident.findFirst.mock.calls[0][0].where.OR[0]).toEqual({ requestedServices: { has: "FIRE" } });
    expect(tx.incident.update).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("makes duplicate flags idempotent and preserves their original reason", async () => {
    const tx = { $queryRaw: vi.fn(), user: operationalUserMock(fire), incident: { findFirst: vi.fn().mockResolvedValue({ incidentId: "incident" }) }, incidentReviewFlag: { findUnique: vi.fn().mockResolvedValue(pending), create: vi.fn(), update: vi.fn() }, auditLog: { create: vi.fn() } };
    mocks.transaction.mockImplementation(callback => callback(tx));
    expect(await FlagIncidentService("incident", "A different repeated reason", fire)).toMatchObject({ code: 200, data: { flag: { reason: pending.reason } } });
    expect(tx.incidentReviewFlag.create).not.toHaveBeenCalled();
    expect(tx.incidentReviewFlag.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("requires the main admin for decisions and queue reads", async () => {
    expect((await ReviewIncidentFlagService("incident", "flag", input, fire)).code).toBe(403);
    expect((await ListIncidentReviewFlagsService(1, fire)).code).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
  it.each([{ ...pending, status: "DISMISSED" }, { ...pending, updatedAt: new Date("2026-09-30T01:00:00Z") }, { ...pending, incidentId: "another-incident" }])("rejects stale or mismatched review decisions", async current => {
    const tx = { $queryRaw: vi.fn(), user: operationalUserMock(main), incidentReviewFlag: { findUnique: vi.fn().mockResolvedValue(current), update: vi.fn() } };
    mocks.transaction.mockImplementation(callback => callback(tx));
    expect((await ReviewIncidentFlagService("incident", "flag", input, main)).code).toBe(409);
    expect(tx.incidentReviewFlag.update).not.toHaveBeenCalled();
  });
  it("records a review decision without changing dispatch or incident state", async () => {
    const tx = { $queryRaw: vi.fn(), user: operationalUserMock(main), incidentReviewFlag: { findUnique: vi.fn().mockResolvedValue(pending), update: vi.fn().mockResolvedValue({ ...pending, status: "CONFIRMED" }) }, auditLog: { create: vi.fn() }, incident: { update: vi.fn() }, incidentServiceResponse: { updateMany: vi.fn() } };
    mocks.transaction.mockImplementation(callback => callback(tx));
    expect((await ReviewIncidentFlagService("incident", "flag", input, main)).code).toBe(200);
    expect(tx.auditLog.create.mock.calls[0][0].data.action).toBe("INCIDENT_FLAG_REVIEWED");
    expect(tx.incident.update).not.toHaveBeenCalled();
    expect(tx.incidentServiceResponse.updateMany).not.toHaveBeenCalled();
  });

  it('corrects a confirmation with an immutable audit of the earlier decision and no operational changes', async () => {
    const confirmed = { ...pending, status: 'CONFIRMED', reviewNotes: 'Earlier mistaken confirmation', reviewedBy: 'earlier-main', reviewedAt: new Date('2026-09-30T01:00:00Z') };
    const tx = { $queryRaw: vi.fn(), user: operationalUserMock(main), incidentReviewFlag: { findUnique: vi.fn().mockResolvedValue(confirmed), update: vi.fn().mockResolvedValue({ ...confirmed, status: 'DISMISSED' }) }, auditLog: { create: vi.fn() }, incident: { update: vi.fn() }, incidentServiceResponse: { updateMany: vi.fn() } };
    mocks.transaction.mockImplementation(callback => callback(tx));
    expect((await CorrectIncidentFlagService('incident', 'flag', { reviewNotes: 'On-site check confirmed a genuine emergency.', expectedUpdatedAt: pending.updatedAt.toISOString() }, main)).code).toBe(200);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'INCIDENT_FLAG_CORRECTED', metadata: expect.objectContaining({ previousStatus: 'CONFIRMED', previousReviewNotes: confirmed.reviewNotes, previousReviewedBy: confirmed.reviewedBy, previousReviewedAt: confirmed.reviewedAt.toISOString(), status: 'DISMISSED' }) }) }));
    expect(tx.incident.update).not.toHaveBeenCalled();
    expect(tx.incidentServiceResponse.updateMany).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalled();
  });

  it.each(['PENDING', 'DISMISSED'])('cannot correct a %s flag or use the ordinary review path to reverse decisions', async status => {
    const tx = { $queryRaw: vi.fn(), user: operationalUserMock(main), incidentReviewFlag: { findUnique: vi.fn().mockResolvedValue({ ...pending, status }), update: vi.fn() } };
    mocks.transaction.mockImplementation(callback => callback(tx));
    expect((await CorrectIncidentFlagService('incident', 'flag', input, main)).code).toBe(409);
    tx.incidentReviewFlag.findUnique.mockResolvedValue({ ...pending, status: 'CONFIRMED' });
    expect((await ReviewIncidentFlagService('incident', 'flag', input, main)).code).toBe(409);
    expect(tx.incidentReviewFlag.update).not.toHaveBeenCalled();
  });

  it('requires Main Admin and valid notes for a correction', async () => {
    expect((await CorrectIncidentFlagService('incident', 'flag', input, fire)).code).toBe(403);
    expect((await CorrectIncidentFlagService('incident', 'flag', { ...input, reviewNotes: 'short' }, main)).code).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('places oldest pending flags before completed confirmations', async () => {
    mocks.findMany.mockResolvedValue([]); mocks.count.mockResolvedValue(0);
    expect((await ListIncidentReviewFlagsService(1, main)).code).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ status: 'asc' }, { updatedAt: 'asc' }, { reviewFlagId: 'asc' }] }));
  });
});
