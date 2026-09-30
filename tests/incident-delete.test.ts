import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), enqueueCleanup: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/jobs', () => ({ enqueueAssetCleanup: mocks.enqueueCleanup }));

import { IncidentRepository } from '@/repositories/incident.repository';
import { DeleteIncidentService } from '@/services/incident/delete-incident-service';

const closed = { incidentId: 'incident-id', title: 'Closed fire', status: 'CLOSED', reportedBy: 'citizen' };
const main = { sub: 'admin', role: 'ADMIN', department: 'MAIN', isMainAdmin: true, type: 'access' } as const;
const confirmation = { reason: 'Confirmed false report after review', confirmation: 'DELETE' };

describe('safe incident deletion', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it('does not let a citizen erase incident evidence', async () => {
    expect((await DeleteIncidentService('incident-id', { ...main, role: 'USER' }, confirmation)).code).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('requires an administrator to close the workflow first', async () => {
    vi.spyOn(IncidentRepository.prototype, 'findById').mockResolvedValue({ ...closed, status: 'ACTIVE' } as never);
    const result = await DeleteIncidentService('incident-id', main, confirmation);
    expect(result).toMatchObject({ code: 409, message: 'Close the incident before permanently deleting it' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('cleans relations and evidence before deleting a closed incident', async () => {
    vi.spyOn(IncidentRepository.prototype, 'findById').mockResolvedValue(closed as never);
    const tx = {
      $queryRaw: vi.fn(),
      incident: { findUnique: vi.fn().mockResolvedValue({ ...closed, attachments: [{ publicId: 'proof' }], incidentUnits: [{ unitId: 'unit', status: 'RETURNED' }], tasks: [], reviewFlags: [] }), delete: vi.fn() },
      alert: { updateMany: vi.fn() }, task: { deleteMany: vi.fn() }, attachment: { deleteMany: vi.fn() },
      incidentUnit: { deleteMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      unit: { updateMany: vi.fn() }, auditLog: { create: vi.fn() },
    };
    mocks.transaction.mockImplementation(callback => callback(tx));
    mocks.enqueueCleanup.mockResolvedValue(undefined);
    expect((await DeleteIncidentService('incident-id', main, confirmation)).code).toBe(200);
    expect(mocks.enqueueCleanup).toHaveBeenCalledWith(tx, 'proof');
    expect(tx.alert.updateMany).toHaveBeenCalledWith({ where: { incidentId: 'incident-id' }, data: { incidentId: null } });
    expect(tx.task.deleteMany).toHaveBeenCalled();
    expect(tx.incidentUnit.deleteMany).toHaveBeenCalled();
    expect(tx.attachment.deleteMany).toHaveBeenCalled();
    expect(tx.incident.delete).toHaveBeenCalled();
    expect(tx.unit.updateMany).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it('keeps database deletion atomic when cleanup queue insertion fails', async () => {
    vi.spyOn(IncidentRepository.prototype, 'findById').mockResolvedValue(closed as never);
    const deleteIncident = vi.fn();
    mocks.enqueueCleanup.mockRejectedValue(new Error('database unavailable'));
    mocks.transaction.mockImplementation(callback => callback({
      $queryRaw: vi.fn(),
      incident: { findUnique: vi.fn().mockResolvedValue({ ...closed, attachments: [{ publicId: 'proof' }], incidentUnits: [], tasks: [], reviewFlags: [] }), delete: deleteIncident },
    }));
    expect((await DeleteIncidentService('incident-id', main, confirmation)).code).toBe(500);
    expect(deleteIncident).not.toHaveBeenCalled();
  });

  it('denies department admins and forged main-admin assignments at the service boundary', async () => {
    for (const actor of [{ ...main, department: 'FIRE' as const }, { ...main, isMainAdmin: false }, { ...main, role: 'DISPATCHER' }]) {
      expect((await DeleteIncidentService('incident-id', actor, confirmation)).code).toBe(403);
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('requires a reason and deliberate confirmation', async () => {
    expect((await DeleteIncidentService('incident-id', main, { reason: '', confirmation: 'DELETE' })).code).toBe(400);
    expect((await DeleteIncidentService('incident-id', main, { ...confirmation, confirmation: 'delete' })).code).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([{ incidentUnits: [{ unitId: 'unit', status: 'ON_SCENE' }], tasks: [] }, { incidentUnits: [], tasks: [{ status: 'IN_PROGRESS' }] }])('preserves evidence while operational work remains', async (work) => {
    vi.spyOn(IncidentRepository.prototype, 'findById').mockResolvedValue(closed as never);
    const deletion = vi.fn();
    mocks.transaction.mockImplementation(callback => callback({ $queryRaw: vi.fn(), incident: { findUnique: vi.fn().mockResolvedValue({ ...closed, ...work, attachments: [{ publicId: 'proof' }], reviewFlags: [] }), delete: deletion } }));
    expect((await DeleteIncidentService('incident-id', main, confirmation)).code).toBe(409);
    expect(mocks.enqueueCleanup).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
  });
});
