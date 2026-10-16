import { beforeEach, describe, expect, it, vi } from 'vitest';
const findMany = vi.hoisted(() => vi.fn());
vi.mock('@/lib/prisma', () => ({ prisma: { incident: { findMany } } }));
import { withNearbyReportNotices } from '@/services/incident/nearby-report-notices';
import type { IncidentStatus, ResponseService } from '@/generated/prisma';

const report = (service: ResponseService = 'FIRE', status: IncidentStatus = 'RESPONDING') => ({
  incidentId: 'own', typeId: 'type', status, latitude: 10.251, longitude: 123.949,
  requestedServices: [service], type: { typeName: service },
});
beforeEach(() => { vi.clearAllMocks(); findMany.mockResolvedValue([]); });
describe('scope-safe nearby report advisories', () => {
  it.each(['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const)('warns for nearby %s without exposing another report', async service => {
    findMany.mockResolvedValue([{ ...report(service), incidentId: 'private-other-id', latitude: 10.2513 }]);
    const scope = { requestedServices: { has: service } };
    const [result] = await withNearbyReportNotices([report(service)], scope);
    expect(result.nearbyReportWarning).toBe('POSSIBLE_DUPLICATE');
    expect(JSON.stringify(result)).not.toContain('private-other-id');
    expect(findMany.mock.calls[0][0].where.AND).toContainEqual(scope);
    expect(findMany.mock.calls[0][0]).toMatchObject({ take: 101, where: { AND: expect.arrayContaining([{ incidentId: { not: 'own' } }]) } });
  });
  it('does not infer duplication from a different response service', async () => {
    findMany.mockResolvedValue([{ ...report('MEDICAL'), incidentId: 'other' }]);
    expect((await withNearbyReportNotices([report('FIRE')], {}))[0].nearbyReportWarning).toBeUndefined();
  });
  it('does not warn outside 100 metres or for completed records', async () => {
    findMany.mockResolvedValue([{ ...report(), incidentId: 'far', latitude: 10.26 }]);
    expect((await withNearbyReportNotices([report()], {}))[0].nearbyReportWarning).toBeUndefined();
    findMany.mockClear();
    expect((await withNearbyReportNotices([report('FIRE', 'RESOLVED')], {}))[0].nearbyReportWarning).toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });
  it('keeps reports available when the advisory query fails', async () => {
    findMany.mockRejectedValue(new Error('synthetic lookup unavailable'));
    const [result] = await withNearbyReportNotices([report()], {});
    expect(result).toMatchObject({ incidentId: 'own', nearbyReportWarning: 'UNAVAILABLE' });
  });
  it('bounds optional warning work to five queries and does not claim a truncated negative is complete', async () => {
    findMany.mockResolvedValue(Array.from({ length: 101 }, (_, i) => ({ ...report('MEDICAL'), incidentId: `other-${i}` })));
    const result = await withNearbyReportNotices(Array.from({ length: 7 }, () => report('FIRE')), {});
    expect(findMany).toHaveBeenCalledTimes(5);
    expect(result.every(item => item.nearbyReportWarning === 'UNAVAILABLE')).toBe(true);
  });
});
