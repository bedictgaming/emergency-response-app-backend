import { beforeEach, describe, expect, it, vi } from 'vitest';
import { operationalUserMock } from './helpers/operational-account';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), cleanup: vi.fn(), event: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/jobs', () => ({ enqueueAssetCleanup: mocks.cleanup }));
vi.mock('@/lib/events', () => ({ publishEmergencyEvent: mocks.event }));
import { CancelFalseIncidentService } from '@/services/incident/cancel-false-incident-service';
import { DeleteIncidentService } from '@/services/incident/delete-incident-service';
import { IncidentRepository } from '@/repositories/incident.repository';
import { cancelFalseIncidentSchema, deleteIncidentSchema } from '@/validation/incident/review-incident.schema';

const main = { sub: 'main', role: 'ADMIN', department: 'MAIN', isMainAdmin: true, sessionId: 'session', type: 'access' } as const;
const date = new Date('2026-10-13T00:00:00.000Z');
const version = { reviewFlagId: 'flag', expectedReviewUpdatedAt: date.toISOString(), expectedIncidentUpdatedAt: date.toISOString() };
const reason = 'Confirmed after contacting the synthetic reporter.';
function fixture(overrides: Record<string, unknown> = {}) {
  const current = { incidentId: 'report', title: 'Synthetic report', status: 'RESPONDING', mergedIntoId: null, updatedAt: date,
    reviewFlags: [{ reviewFlagId: 'flag', incidentId: 'report', status: 'CONFIRMED', updatedAt: date, reviewNotes: reason }],
    serviceResponses: [{ service: 'FIRE', status: 'RESPONDING' }, { service: 'MEDICAL', status: 'RESOLVED' }],
    attachments: [{ publicId: 'synthetic-proof' }], incidentUnits: [], tasks: [], ...overrides };
  const tx = { $queryRaw: vi.fn(), user: operationalUserMock(main),
    incident: { findUnique: vi.fn().mockResolvedValue(current), update: vi.fn(), delete: vi.fn() },
    incidentServiceResponse: { updateMany: vi.fn() }, auditLog: { create: vi.fn() },
    alert: { updateMany: vi.fn() }, task: { deleteMany: vi.fn() }, attachment: { deleteMany: vi.fn() },
    incidentUnit: { deleteMany: vi.fn(), count: vi.fn().mockResolvedValue(0) }, unit: { updateMany: vi.fn() } };
  mocks.transaction.mockImplementation(callback => callback(tx));
  vi.spyOn(IncidentRepository.prototype, 'findById').mockResolvedValue(current as never);
  return { tx, current };
}
const run = (action: string, supplied = version) => action === 'cancel'
  ? CancelFalseIncidentService('report', { reason, ...supplied }, main)
  : DeleteIncidentService('report', main, { reason, confirmation: 'DELETE', falseReport: supplied });
describe('Main confirmed-false disposition', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
  it('cancels without department resolution, retains evidence and genuine completed response history', async () => {
    const { tx } = fixture();
    expect((await run('cancel')).code).toBe(200);
    expect(tx.incident.update).toHaveBeenCalledWith({ where: { incidentId: 'report' }, data: { status: 'CANCELLED' } });
    expect(tx.incidentServiceResponse.updateMany).toHaveBeenCalledWith({ where: { incidentId: 'report', status: 'RESPONDING' }, data: { status: 'CANCELLED' } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'INCIDENT_CANCELLED_FALSE', metadata: expect.objectContaining({ reason, previousStatus: 'RESPONDING', reviewFlagId: 'flag' }) }) }));
    expect(tx.incident.delete).not.toHaveBeenCalled(); expect(tx.attachment.deleteMany).not.toHaveBeenCalled(); expect(mocks.cleanup).not.toHaveBeenCalled();
  });
  it('permanently deletes a version-bound confirmed false RESPONDING report, keeping an audit tombstone', async () => {
    const { tx } = fixture();
    expect((await run('delete')).code).toBe(200);
    expect(tx.incident.delete).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledWith(tx, 'synthetic-proof');
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'INCIDENT_DELETED', metadata: expect.objectContaining({ status: 'RESPONDING', confirmedFalseDisposition: true }) }) }));
  });
  for (const action of ['cancel', 'delete']) {
    it.each([
      { reviewFlags: [] },
      { reviewFlags: [{ reviewFlagId: 'flag', incidentId: 'report', status: 'PENDING', updatedAt: date }] },
      { reviewFlags: [{ reviewFlagId: 'flag', incidentId: 'other', status: 'CONFIRMED', updatedAt: date }] },
      { reviewFlags: [{ reviewFlagId: 'flag', incidentId: 'report', status: 'DISMISSED', updatedAt: date }] },
      { updatedAt: new Date(date.getTime() + 1) },
      { mergedIntoId: 'other' },
      { incidentUnits: [{ unitId: 'unit', status: 'ON_SCENE' }] },
      { tasks: [{ status: 'IN_PROGRESS' }] },
    ])(action + ' denies stale, unconfirmed or outstanding-work targets without side effects', async override => {
      const { tx } = fixture(override);
      expect((await run(action)).code).toBe(409);
      expect(tx.incident.update).not.toHaveBeenCalled(); expect(tx.incident.delete).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled(); expect(mocks.cleanup).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
    });
    it(action + ' rechecks current Main authority before the incident lock', async () => {
      const { tx } = fixture(); tx.user.findUnique.mockResolvedValue({ role: 'USER', status: 'ACTIVE', department: null, isMainAdmin: false, tokens: [{ id: 'session' }] } as never);
      expect((await run(action)).code).toBe(403);
      expect(tx.incident.findUnique).not.toHaveBeenCalled();
      expect(tx.incident.delete).not.toHaveBeenCalled(); expect(tx.incident.update).not.toHaveBeenCalled();
    });
    it(action + ' rejects invalid versions and foreign roles', async () => {
      fixture(); expect((await run(action, { ...version, expectedReviewUpdatedAt: 'invalid' })).code).toBe(400);
      const foreign = { ...main, department: 'FIRE' as const, isMainAdmin: false };
      expect((await CancelFalseIncidentService('report', { reason, ...version }, foreign)).code).toBe(403);
      expect((await DeleteIncidentService('report', foreign, { reason, confirmation: 'DELETE', falseReport: version })).code).toBe(403);
      expect(mocks.transaction).not.toHaveBeenCalled();
    });
  }
  it('makes repeated cancellation idempotent without duplicate audit or status writes', async () => {
    const { tx } = fixture({ status: 'CANCELLED', updatedAt: new Date(date.getTime() + 1) });
    expect((await run('cancel')).code).toBe(200);
    expect(tx.incident.update).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('does not provide unversioned early deletion', async () => {
    fixture(); expect((await DeleteIncidentService('report', main, { reason, confirmation: 'DELETE' })).code).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('requires DELETE, meaningful reasons and strict cancellation payloads', () => {
    const params = { id: '10000000-0000-4000-8000-000000000001' }, body = { ...version, reviewFlagId: '20000000-0000-4000-8000-000000000002', reason };
    expect(cancelFalseIncidentSchema.safeParse({ params, body }).success).toBe(true);
    expect(cancelFalseIncidentSchema.safeParse({ params, body: { ...body, status: 'RESOLVED' } }).success).toBe(false);
    expect(cancelFalseIncidentSchema.safeParse({ params, body: { ...body, reason: 'short' } }).success).toBe(false);
    expect(deleteIncidentSchema.safeParse({ params, body: { reason, confirmation: 'delete', falseReport: body } }).success).toBe(false);
  });
});
