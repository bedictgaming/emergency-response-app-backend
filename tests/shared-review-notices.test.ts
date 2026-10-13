import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentReviewFlag } from '@/generated/prisma';
import type { JwtPayload } from '@/lib/jwt';

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn(), groupBy: vi.fn(), serviceGroupBy: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {
  incident: { findMany: mocks.findMany, findUnique: mocks.findUnique, groupBy: mocks.groupBy },
  incidentServiceResponse: { groupBy: mocks.serviceGroupBy },
} }));
import { presentIncidentReviews, reviewNoticeDepartmentFor, reviewNoticeIncidentScope } from '@/lib/incident-review-notices';
import { reviewDepartmentFor } from '@/services/incident/review-incident-service';
import { IncidentRepository } from '@/repositories/incident.repository';
import { GetAllIncidentsService } from '@/services/incident/get-all-incidents-service';
import { GetIncidentService } from '@/services/incident/get-incident-service';

const actor: JwtPayload = { sub: 'synthetic-staff', role: 'ADMIN', type: 'access', department: 'FIRE', isMainAdmin: false };
const flags = ['PENDING', 'CONFIRMED', 'DISMISSED'].map((status, index) => ({
  reviewFlagId: `synthetic-${index}`, incidentId: 'synthetic-report', department: index === 1 ? 'FIRE' : 'DRRMO', status,
  reason: 'Synthetic investigation reason.', reviewNotes: index ? 'Synthetic Main explanation.' : null,
  flaggedBy: 'private-staff-id', reviewedBy: index ? 'private-main-id' : null,
  reviewedAt: index ? new Date('2026-10-13T01:00:00Z') : null,
  createdAt: new Date('2026-10-13T00:00:00Z'), updatedAt: new Date('2026-10-13T01:00:00Z'),
})) as IncidentReviewFlag[];
const report = { incidentId: 'synthetic-report', status: 'RESPONDING', reviewFlags: flags };

describe('assigned-department read-only review notices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([report]); mocks.findUnique.mockResolvedValue(report);
    mocks.groupBy.mockResolvedValue([{ status: 'RESPONDING', _count: { _all: 1 } }]);
    mocks.serviceGroupBy.mockResolvedValue([]);
  });
  it.each(['FIRE', 'MEDICAL', 'POLICE', 'DRRMO'] as const)('permits assigned %s admins and legacy dispatchers to read, not decide foreign flags', department => {
    expect(reviewNoticeDepartmentFor({ ...actor, department })).toBe(department);
    expect(reviewNoticeDepartmentFor({ ...actor, role: 'DISPATCHER', department })).toBe(department);
    expect(reviewDepartmentFor({ ...actor, role: 'DISPATCHER', department })).toBeUndefined();
  });
  it('requires the exact Main assignment for all-department context', () => {
    expect(reviewNoticeDepartmentFor({ ...actor, department: 'MAIN', isMainAdmin: true })).toBe('ALL');
    expect(reviewNoticeIncidentScope('ALL')).toEqual({});
    expect(reviewNoticeIncidentScope('DRRMO')).toMatchObject({ OR: [{ requestedServices: { has: 'HAZARD' } }, expect.anything()] });
  });
  it.each([
    { ...actor, role: 'USER' }, { ...actor, role: 'RESPONDER' }, { ...actor, role: 'UNKNOWN' },
    { ...actor, department: null }, { ...actor, department: 'MAIN', isMainAdmin: false },
    { ...actor, isMainAdmin: true }, { ...actor, role: 'DISPATCHER', department: 'MAIN', isMainAdmin: true },
    { ...actor, department: 'FORGED' },
  ])('does not derive shared scope from an invalid actor tuple', invalid => {
    expect(reviewNoticeDepartmentFor(invalid as JwtPayload)).toBeUndefined();
  });
  it('shares every current decision without staff IDs or extra mutation fields', () => {
    const result = presentIncidentReviews(report, 'FIRE', 'FIRE');
    expect(result.reviewFlags).toEqual([flags[1]]);
    expect(result.reviewNotices).toHaveLength(3);
    expect(result.reviewNotices?.map(flag => flag.status)).toEqual(['PENDING', 'CONFIRMED', 'DISMISSED']);
    for (const flag of result.reviewNotices ?? []) {
      expect(Object.keys(flag).sort()).toEqual(['reviewFlagId', 'department', 'status', 'reason', 'reviewNotes', 'createdAt', 'updatedAt', 'reviewedAt'].sort());
      expect(flag).not.toHaveProperty('flaggedBy'); expect(flag).not.toHaveProperty('reviewedBy');
      expect(flag).not.toHaveProperty('incidentId');
    }
    expect(report.reviewFlags).toEqual(flags);
  });
  it('keeps Main action flags active-only and dispatchers read-only', () => {
    expect(presentIncidentReviews(report, 'ALL', 'ALL').reviewFlags).toEqual(flags.slice(0, 2));
    const dispatcher = presentIncidentReviews(report, undefined, 'MEDICAL');
    expect(dispatcher).not.toHaveProperty('reviewFlags'); expect(dispatcher.reviewNotices).toHaveLength(3);
  });
  it('strips staff context from citizen results even if a repository supplies it', () => {
    const result = presentIncidentReviews({ ...report, reviewNotices: ['untrusted'] });
    expect(result).toEqual({ incidentId: report.incidentId, status: 'RESPONDING' });
  });
  it('bounds shared relation reads and rechecks assignment with the unique detail lookup', async () => {
    const repo = new IncidentRepository();
    await repo.findAll({ reviewNoticeDepartment: 'FIRE', page: 2, limit: 5 });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5,
      include: expect.objectContaining({ reviewFlags: { orderBy: [{ createdAt: 'asc' }, { reviewFlagId: 'asc' }], take: 5 } }) }));
    await repo.findById(report.incidentId, 'FIRE', 'FIRE');
    expect(mocks.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: {
      incidentId: report.incidentId, AND: [reviewNoticeIncidentScope('FIRE')],
    } }));
    await repo.findById(report.incidentId);
    expect(mocks.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({ include: expect.objectContaining({ reviewFlags: false }) }));
  });
  it('intersects list and summary scopes without changing response work or pagination', async () => {
    const scope = { reportedBy: 'synthetic-citizen' };
    const result = await GetAllIncidentsService({ scope, reviewDepartment: 'FIRE', reviewNoticeDepartment: 'FIRE', includeVerifiedSummary: true, page: 2, limit: 5 });
    const authorized = { AND: [scope, reviewNoticeIncidentScope('FIRE')] };
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ AND: [authorized] }) }));
    expect(mocks.groupBy).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: expect.objectContaining({ AND: [authorized] }) }));
    expect(mocks.groupBy).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({ AND: [{ AND: [authorized, { verificationStatus: 'VERIFIED', status: { not: 'CANCELLED' }, reviewFlags: { none: { status: 'CONFIRMED' } } }] }] }) }));
    expect(result.data?.pagination).toEqual({ page: 2, limit: 5, total: 1, pages: 1 });
    expect(result.data?.incidents[0]).toMatchObject({ status: 'RESPONDING', reviewNotices: expect.any(Array), reviewFlags: [flags[1]] });
  });
  it('presents list/detail consistently, including cleared flags and empty legacy results', async () => {
    expect((await GetIncidentService(report.incidentId, 'FIRE', 'FIRE')).data?.incident.reviewNotices).toHaveLength(3);
    expect((await GetAllIncidentsService({ includeTotal: false })).data?.incidents[0]).not.toHaveProperty('reviewNotices');
    mocks.findUnique.mockResolvedValue({ incidentId: 'legacy' });
    expect((await GetIncidentService('legacy', 'FIRE', 'FIRE')).data?.incident).toMatchObject({ reviewFlags: [], reviewNotices: [] });
    mocks.findUnique.mockResolvedValue(null);
    expect((await GetIncidentService('unassigned', 'FIRE', 'FIRE')).code).toBe(404);
  });
});
