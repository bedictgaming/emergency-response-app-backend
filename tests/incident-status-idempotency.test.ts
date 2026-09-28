import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), publish: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/events', () => ({ publishEmergencyEvent: mocks.publish }));

import { IncidentRepository } from '@/repositories/incident.repository';
import { UpdateIncidentService } from '@/services/incident/update-incident-service';

const incident = (status: string) => ({
  incidentId: 'incident-id', typeId: 'fire-type', status, verificationStatus: 'VERIFIED', updatedAt: new Date(),
  attachments: [{ attachmentId: 'proof-id', publicId: 'private/cloudinary-id', fileUrl: 'https://private.example/proof' }],
});

describe('incident status idempotency', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it('returns success without writing when the target status is already applied', async () => {
    vi.spyOn(IncidentRepository.prototype, 'findById').mockResolvedValue(incident('ACTIVE') as never);
    const result = await UpdateIncidentService('incident-id', { status: 'ACTIVE' }, 'operator');
    expect(result.code).toBe(200);
    expect(result.data?.incident.attachments?.[0]).not.toHaveProperty('publicId');
    expect(result.data?.incident.attachments?.[0]?.fileUrl).toContain('/api/attachments/v1/proof-id/content');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('reconciles a same-target concurrent update as success', async () => {
    vi.spyOn(IncidentRepository.prototype, 'findById')
      .mockResolvedValueOnce(incident('ACTIVE') as never)
      .mockResolvedValueOnce(incident('RESOLVED') as never);
    mocks.transaction.mockImplementation(async callback => callback({
      incident: { update: vi.fn().mockRejectedValue({ code: 'P2025' }) },
      auditLog: { create: vi.fn() },
    }));
    const result = await UpdateIncidentService('incident-id', { status: 'RESOLVED' }, 'operator');
    expect(result.code).toBe(200);
    expect(result.data?.incident.status).toBe('RESOLVED');
    expect(result.data?.incident.attachments?.[0]).not.toHaveProperty('publicId');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('allows the main-admin workflow to resolve a responding incident and all service responses', async () => {
    vi.spyOn(IncidentRepository.prototype, 'findById').mockResolvedValue(incident('RESPONDING') as never);
    const updateIncident = vi.fn().mockResolvedValue({ ...incident('RESOLVED'), serviceResponses: [{ service: 'FIRE', status: 'RESPONDING' }] });
    const findUpdatedIncident = vi.fn().mockResolvedValue({ ...incident('RESOLVED'), serviceResponses: [{ service: 'FIRE', status: 'RESOLVED' }] });
    const updateResponses = vi.fn().mockResolvedValue({ count: 2 });
    const createAudit = vi.fn().mockResolvedValue({});
    mocks.transaction.mockImplementation(async callback => callback({
      incident: { update: updateIncident, findUniqueOrThrow: findUpdatedIncident },
      incidentServiceResponse: { updateMany: updateResponses },
      auditLog: { create: createAudit },
    }));

    const result = await UpdateIncidentService('incident-id', { status: 'RESOLVED' }, 'main-admin');

    expect(result.code).toBe(200);
    expect(result.data?.incident.serviceResponses).toEqual([{ service: 'FIRE', status: 'RESOLVED' }]);
    expect(result.data?.incident.attachments?.[0]).not.toHaveProperty('publicId');
    expect(updateResponses).toHaveBeenCalledWith(expect.objectContaining({
      where: { incidentId: 'incident-id', status: { not: 'RESOLVED' } },
      data: expect.objectContaining({ status: 'RESOLVED', resolvedBy: 'main-admin' }),
    }));
    expect(createAudit).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'INCIDENT_RESOLVED_OVERRIDE' }),
    }));
  });

  it('rejects category changes before they can transfer an incident without its response work', async () => {
    vi.spyOn(IncidentRepository.prototype, 'findById').mockResolvedValue(incident('RESPONDING') as never);
    const result = await UpdateIncidentService('incident-id', { typeId: 'medical-type' }, 'operator');
    expect(result.code).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
