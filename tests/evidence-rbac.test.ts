import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), destroy: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/cloudinary', () => ({ deleteImage: mocks.destroy }));
import { AttachmentRepository } from '@/repositories/attachment.repository';
import { IncidentUnitRepository } from '@/repositories/incident-unit.repository';
import { GetAttachmentService } from '@/services/attachment/get-attachment-service';
import { DeleteAttachmentService } from '@/services/attachment/delete-attachment-service';
import { UpdateIncidentUnitService } from '@/services/incident-unit/update-incident-unit-service';
beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
describe('evidence access and retention', () => {
  const evidence = { attachmentId: 'evidence', incidentId: 'incident', uploader: { id: 'owner' }, incident: { reportedBy: 'owner' }, publicId: 'cloud-proof' };
  it('blocks cross-citizen attachment reads', async () => {
    vi.spyOn(AttachmentRepository.prototype, 'findById').mockResolvedValue(evidence as never);
    expect((await GetAttachmentService('evidence', 'stranger', 'USER')).code).toBe(403);
    expect((await GetAttachmentService('evidence', 'owner', 'USER')).code).toBe(200);
  });
  it('prevents the submitting citizen from deleting evidence', async () => {
    vi.spyOn(AttachmentRepository.prototype, 'findById').mockResolvedValue(evidence as never);
    expect((await DeleteAttachmentService('evidence', 'owner', 'USER')).code).toBe(403);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
  it('retains the final verified photo even when staff request deletion', async () => {
    vi.spyOn(AttachmentRepository.prototype, 'findById').mockResolvedValue(evidence as never);
    mocks.transaction.mockImplementation(callback => callback({ $queryRaw: vi.fn(), attachment: { count: vi.fn().mockResolvedValue(1) } }));
    expect((await DeleteAttachmentService('evidence', 'admin', 'ADMIN')).code).toBe(409);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
});
describe('field responder dispatch scope', () => {
  it('blocks dispatch updates from another unit and role edits by a member', async () => {
    vi.spyOn(IncidentUnitRepository.prototype, 'findById').mockResolvedValue({ status: 'DISPATCHED', unit: { responders: [{ user: { id: 'member' } }] } } as never);
    expect((await UpdateIncidentUnitService('dispatch', { status: 'ON_SCENE' }, 'other', 'RESPONDER')).code).toBe(403);
    expect((await UpdateIncidentUnitService('dispatch', { role: 'Commander' }, 'member', 'RESPONDER')).code).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
