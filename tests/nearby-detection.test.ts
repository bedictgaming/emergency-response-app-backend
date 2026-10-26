import { beforeEach, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@/lib/jwt';
const mocks = vi.hoisted(() => ({ first: vi.fn(), many: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }));
import { NearbyDetectionService } from '@/services/incident/nearby-detection-service';
import { nearbyDetectionBody } from '@/validation/incident/nearby-detection.schema';
const citizen = { sub: 'citizen', role: 'USER', type: 'access' } as JwtPayload;
const admin = (department = 'FIRE') => ({ sub: 'staff', role: 'ADMIN', type: 'access', department, isMainAdmin: department === 'MAIN' } as JwtPayload);
const id = '10000000-0000-4000-8000-000000000001';
const point = { latitude: 10.252191, longitude: 123.949475 };
const input = { kind: 'citizen' as const, ...point, services: ['FIRE' as const] };
function row(latitude = point.latitude + 0.0003, service = 'FIRE') {
  return { incidentId: '20000000-0000-4000-8000-000000000002', ...point, latitude, typeId: 'type', requestedServices: [service],
    type: { typeName: service }, status: 'RESPONDING', verificationStatus: 'VERIFIED', mergedIntoId: null, reviewFlags: [],
    title: 'Must not leak', description: 'Private description', reportedBy: 'peer', email: 'private@example.test' };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.transaction.mockImplementation(fn => fn({ incident: { findFirst: mocks.first, findMany: mocks.many } }));
  mocks.first.mockResolvedValue({ ...row(point.latitude), incidentId: id }); mocks.many.mockResolvedValue([row()]);
});
it('returns citizen presence only, excluding their own reports in the query', async () => {
  const result = await NearbyDetectionService(input, citizen);
  expect(result).toEqual({ code: 200, data: { radiusMeters: 100, active: true, nearby: true, complete: true } });
  expect(JSON.stringify(result)).not.toMatch(/Private|Must not leak|20000000|example|latitude|email|reportedBy/);
  expect(mocks.many.mock.calls[0][0].where.AND).toContainEqual({ reportedBy: { not: citizen.sub } });
  expect(mocks.many.mock.calls[0][0]).toMatchObject({ take: 201 });
});
it('uses the persisted authorized selected report as the operational circle center', async () => {
  const result = await NearbyDetectionService({ kind: 'department', incidentId: id }, admin());
  expect(result).toMatchObject({ code: 200, data: { nearby: true, center: point, items: [expect.objectContaining({ distanceMeters: 33 })] } });
  expect(mocks.first.mock.calls[0][0].where.AND[1].OR[0]).toEqual({ requestedServices: { has: 'FIRE' } });
  expect(mocks.many.mock.calls[0][0].where.AND).toContainEqual({ incidentId: { not: id } });
  expect(JSON.stringify(result)).not.toMatch(/Private|description|title|email/);
});
it.each(['FIRE', 'MEDICAL', 'POLICE', 'DRRMO', 'MAIN'])('enforces %s scope for every nearby read', async department => {
  await NearbyDetectionService({ kind: 'department', incidentId: id }, admin(department));
  const scope = mocks.first.mock.calls[0][0].where.AND[1];
  expect(mocks.many.mock.calls[0][0].where.AND).toContainEqual(scope);
  if (department === 'MAIN') expect(scope).toEqual({});
  else expect(scope.OR[0]).toEqual({ requestedServices: { has: department === 'DRRMO' ? 'HAZARD' : department } });
});
it('does not query peers when the selected report is not accessible', async () => {
  mocks.first.mockResolvedValue(null);
  expect((await NearbyDetectionService({ kind: 'department', incidentId: id }, admin())).code).toBe(403);
  expect(mocks.many).not.toHaveBeenCalled();
});
it.each(['RESOLVED', 'CLOSED', 'CANCELLED'])('pauses detection for a %s selected report', async status => {
  mocks.first.mockResolvedValue({ ...row(), status });
  expect(await NearbyDetectionService({ kind: 'department', incidentId: id }, admin())).toMatchObject({ code: 200, data: { active: false, items: [] } });
  expect(mocks.many).not.toHaveBeenCalled();
});
it('excludes rejected, merged and confirmed-false reports in SQL', async () => {
  await NearbyDetectionService(input, citizen);
  expect(mocks.many.mock.calls[0][0].where.AND).toContainEqual({ verificationStatus: { not: 'REJECTED' }, mergedIntoId: null, NOT: { reviewFlags: { some: { status: 'CONFIRMED' } } } });
});
it('uses exact distance and service matching, not the bounding square alone', async () => {
  mocks.many.mockResolvedValue([row(point.latitude + 0.002), row(point.latitude + 0.0001, 'MEDICAL')]);
  expect(await NearbyDetectionService(input, citizen)).toMatchObject({ code: 200, data: { nearby: false, complete: true } });
});
it('accepts a matching shared response service', async () => {
  mocks.many.mockResolvedValue([{ ...row(), requestedServices: ['MEDICAL', 'FIRE'] }]);
  expect(await NearbyDetectionService(input, citizen)).toMatchObject({ data: { nearby: true } });
});
it('returns unknown, not a false all-clear, if the candidate scan is capped', async () => {
  mocks.many.mockResolvedValue(Array.from({ length: 201 }, () => row(point.latitude + 0.01)));
  expect(await NearbyDetectionService(input, citizen)).toMatchObject({ data: { nearby: null, complete: false } });
});
it('caps markers without claiming all results are shown', async () => {
  mocks.many.mockResolvedValue(Array.from({ length: 60 }, (_, index) => ({ ...row(), incidentId: String(index) })));
  const result = await NearbyDetectionService({ kind: 'department', incidentId: id }, admin());
  expect(result.data?.items).toHaveLength(50); expect(result.data?.complete).toBe(false);
});
it('returns a sanitized unavailable response on database failure', async () => {
  mocks.transaction.mockRejectedValue(new Error('private provider details'));
  expect(await NearbyDetectionService(input, citizen)).toEqual({ code: 503, message: 'Nearby detection unavailable. Reports remain unchanged.' });
});
it('rejects cross-mode requests and retired/missing assignments before reading', async () => {
  for (const [body, actor] of [[{ kind: 'department', incidentId: id }, citizen], [input, admin()],
    [{ kind: 'department', incidentId: id }, { ...admin(), department: null }], [input, { ...citizen, role: 'RESPONDER' }]] as const) {
    expect((await NearbyDetectionService(body, actor as JwtPayload)).code).toBe(403);
  }
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it('forbids radius, actor, department and operational coordinate overrides', () => {
  expect(nearbyDetectionBody.safeParse({ kind: 'department', incidentId: id }).success).toBe(true);
  for (const field of ['latitude', 'longitude', 'radius', 'department', 'reportedBy', 'role']) {
    expect(nearbyDetectionBody.safeParse({ kind: 'department', incidentId: id, [field]: 100 }).success).toBe(false);
  }
  expect(nearbyDetectionBody.safeParse({ ...input, latitude: NaN }).success).toBe(false);
  expect(nearbyDetectionBody.safeParse({ ...input, services: [] }).success).toBe(false);
});
