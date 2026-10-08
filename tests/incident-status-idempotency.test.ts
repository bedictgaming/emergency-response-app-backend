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
      .mockResolvedValueOnce(incident('RESOLVED') as never)
      .mockResolvedValueOnce(incident('CLOSED') as never);
    mocks.transaction.mockImplementation(async callback => callback({
      incident: { update: vi.fn().mockRejectedValue({ code: 'P2025' }) },
      auditLog: { create: vi.fn() },
    }));
    const result = await UpdateIncidentService('incident-id', { status: 'CLOSED' }, 'operator');
    expect(result.code).toBe(200);
    expect(result.data?.incident.status).toBe('CLOSED');
    expect(result.data?.incident.attachments?.[0]).not.toHaveProperty('publicId');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each(['OPEN', 'ACTIVE', 'RESPONDING', 'RESOLVED', 'CLOSED'])('rejects direct overall resolution even for Main Admin, with existing status %s', async status => {
    const find = vi.spyOn(IncidentRepository.prototype, 'findById').mockResolvedValue(incident(status) as never);
    const result = await UpdateIncidentService('incident-id', { status: 'RESOLVED' }, 'main-admin');
    expect(result.code).toBe(403);
    expect(find).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('rejects category changes before they can transfer an incident without its response work', async () => {
    vi.spyOn(IncidentRepository.prototype, 'findById').mockResolvedValue(incident('RESPONDING') as never);
    const result = await UpdateIncidentService('incident-id', { typeId: 'medical-type' }, 'operator');
    expect(result.code).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
