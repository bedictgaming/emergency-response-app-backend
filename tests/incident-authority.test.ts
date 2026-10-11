import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findUser: vi.fn(), lockedUser: vi.fn(), findType: vi.fn(), findLocation: vi.fn(), findBarangay: vi.fn(),
  transaction: vi.fn(), queryRaw: vi.fn(), createIncident: vi.fn(), createLocation: vi.fn(),
  findNearby: vi.fn(), audit: vi.fn(), findStaff: vi.fn(), findResponders: vi.fn(),
  publish: vi.fn(), verifyAsset: vi.fn(), notify: vi.fn(), cleanup: vi.fn(), findAttachment: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ prisma: {
  user: { findUnique: m.findUser }, incidentType: { findUnique: m.findType },
  location: { findUnique: m.findLocation }, barangay: { findUnique: m.findBarangay },
  attachment: { findUnique: m.findAttachment }, $transaction: m.transaction,
} }));
vi.mock('@/lib/cloudinary', () => ({ verifyUploadedAsset: m.verifyAsset }));
vi.mock('@/lib/events', () => ({ publishEmergencyEvent: m.publish }));
vi.mock('@/lib/jobs', () => ({ enqueueNotification: m.notify, enqueueAssetCleanup: m.cleanup }));
vi.mock('@/lib/barangay-boundaries', () => ({ resolveBarangayFromCoordinates: () => 'Poblacion' }));
import { CreateIncidentService } from '@/services/incident/create-incident-service';

const actorId = '00000000-0000-4000-8000-000000000010';
const fireAdmin = { role: 'ADMIN', status: 'ACTIVE', department: 'FIRE', isMainAdmin: false };
const input = { title: 'Synthetic authority regression',
  typeId: '00000000-0000-4000-8000-000000000011',
  locationId: '00000000-0000-4000-8000-000000000012',
  barangayId: '00000000-0000-4000-8000-000000000013' };

describe('reporter authority at the incident commit boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.findUser.mockResolvedValue(fireAdmin);
    m.lockedUser.mockResolvedValue(fireAdmin);
    m.findType.mockResolvedValue({ typeId: input.typeId, typeName: 'Fire' });
    m.findLocation.mockResolvedValue({ locationId: input.locationId });
    m.findBarangay.mockResolvedValue({ name: 'Poblacion', status: 'ACTIVE' });
    m.findStaff.mockResolvedValue([]); m.findResponders.mockResolvedValue([]);
    m.findAttachment.mockResolvedValue(null);
    m.queryRaw.mockResolvedValue([{ id: actorId }]);
    m.createIncident.mockImplementation(async ({ data }) => ({ incidentId: 'synthetic-only', ...data }));
    m.transaction.mockImplementation(async callback => callback({
      $queryRaw: m.queryRaw, user: { findUnique: m.lockedUser, findMany: m.findStaff },
      responder: { findMany: m.findResponders }, incident: { create: m.createIncident, findMany: m.findNearby },
      location: { create: m.createLocation }, auditLog: { create: m.audit },
    }));
  });
  function expectNoReportSideEffects() {
    for (const fn of [m.createIncident, m.createLocation, m.findNearby, m.audit, m.findStaff, m.notify, m.publish]) {
      expect(fn).not.toHaveBeenCalled();
    }
  }
  it('locks before rereading current account assignment and accepts unchanged staff', async () => {
    expect((await CreateIncidentService(input, actorId)).code).toBe(201);
    expect(m.lockedUser).toHaveBeenCalledWith({ where: { id: actorId },
      select: { role: true, status: true, department: true, isMainAdmin: true } });
    expect(m.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(m.lockedUser.mock.invocationCallOrder[0]);
    expect(m.lockedUser.mock.invocationCallOrder[0]).toBeLessThan(m.createIncident.mock.invocationCallOrder[0]);
    expect(m.notify).toHaveBeenCalledTimes(1); expect(m.publish).toHaveBeenCalledTimes(1);
  });
  it.each([
    { role: 'USER', status: 'ACTIVE', department: null, isMainAdmin: false },
    { role: 'ADMIN', status: 'ACTIVE', department: 'MEDICAL', isMainAdmin: false },
    { role: 'DISPATCHER', status: 'ACTIVE', department: 'FIRE', isMainAdmin: false },
  ])('rejects changed valid assignment with retryable conflict: %j', async current => {
    m.lockedUser.mockResolvedValue(current);
    const result = await CreateIncidentService({ ...input, duplicateOverrideReason: 'Synthetic staff override' }, actorId);
    expect(result).toMatchObject({ code: 409, message: expect.stringContaining('account permissions changed') });
    expectNoReportSideEffects();
    expect(m.verifyAsset).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...fireAdmin, status: 'INACTIVE' },
    { ...fireAdmin, role: 'RESPONDER' },
    { ...fireAdmin, role: 'ADMIN', department: null },
    { ...fireAdmin, department: 'MAIN', isMainAdmin: false },
    { ...fireAdmin, isMainAdmin: true },
  ])('denies removed/inactive/retired/invalid current authority: %j', async current => {
    m.lockedUser.mockResolvedValue(current);
    expect((await CreateIncidentService(input, actorId)).code).toBe(403);
    expectNoReportSideEffects();
  });
  it('rejects Main access removed in flight even if the new department could handle the report', async () => {
    m.findUser.mockResolvedValue({ ...fireAdmin, department: 'MAIN', isMainAdmin: true });
    m.lockedUser.mockResolvedValue(fireAdmin);
    expect((await CreateIncidentService(input, actorId)).code).toBe(409);
    expectNoReportSideEffects();
  });
  it('never silently upgrades a citizen request to staff privileges', async () => {
    m.findUser.mockResolvedValue({ role: 'USER', department: null, isMainAdmin: false });
    m.verifyAsset.mockResolvedValue({ publicId: 'emergency-incidents/synthetic/test', url: 'https://evidence.invalid/test', format: 'jpg', bytes: 100, width: 10, height: 10 });
    m.findLocation.mockResolvedValue({ locationId: input.locationId, latitude: 10.262, longitude: 123.958 });
    expect((await CreateIncidentService({ ...input, proofAttachment: { publicId: 'emergency-incidents/synthetic/test', fileName: 'synthetic.jpg' } }, actorId)).code).toBe(409);
    expectNoReportSideEffects();
    // Only rejected unreferenced uploads may be queued; never direct provider deletion.
    expect(m.cleanup).toHaveBeenCalledWith(expect.anything(), 'emergency-incidents/synthetic/test');
  });
});
