import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { BACKGROUND_JOBS_ENABLED: true, EVIDENCE_DELETION_ENABLED: false,
    ORPHAN_EVIDENCE_SWEEP_ENABLED: false, EVIDENCE_NAMESPACE: 'emergency-incidents-staging' },
  outbox: { updateMany: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  cleanup: { updateMany: vi.fn(), findMany: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  attachment: { findMany: vi.fn(), findUnique: vi.fn() },
  resources: vi.fn(), destroy: vi.fn(), push: vi.fn(), transaction: vi.fn(),
}));
vi.mock('@/config/env', () => ({ ENV: mocks.env }));
vi.mock('@/lib/prisma', () => ({ prisma: {
  notificationOutbox: mocks.outbox, assetCleanupJob: mocks.cleanup,
  attachment: mocks.attachment, $transaction: mocks.transaction,
} }));
vi.mock('@/lib/cloudinary', () => ({ default: { api: { resources: mocks.resources } }, deleteImage: mocks.destroy }));
vi.mock('@/lib/push', () => ({ sendPushNotification: mocks.push }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  Object.assign(mocks.env, { BACKGROUND_JOBS_ENABLED: true, EVIDENCE_DELETION_ENABLED: false,
    ORPHAN_EVIDENCE_SWEEP_ENABLED: false, EVIDENCE_NAMESPACE: 'emergency-incidents-staging' });
  mocks.outbox.findMany.mockResolvedValue([]);
  mocks.cleanup.findMany.mockResolvedValue([]);
  mocks.cleanup.updateMany.mockResolvedValue({ count: 1 });
  mocks.attachment.findMany.mockResolvedValue([]);
  mocks.attachment.findUnique.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

it('worker-disabled checks also apply when jobs are called directly', async () => {
  mocks.env.BACKGROUND_JOBS_ENABLED = false;
  const { processPendingJobs, sweepOrphanedEvidence } = await import('@/lib/jobs');
  await processPendingJobs(); await sweepOrphanedEvidence();
  expect(mocks.outbox.updateMany).not.toHaveBeenCalled();
  expect(mocks.cleanup.updateMany).not.toHaveBeenCalled();
  expect(mocks.resources).not.toHaveBeenCalled();
});
it('can process notifications without reading or changing cleanup jobs', async () => {
  const { processPendingJobs, sweepOrphanedEvidence } = await import('@/lib/jobs');
  await processPendingJobs(); await sweepOrphanedEvidence();
  expect(mocks.outbox.findMany).toHaveBeenCalled();
  expect(mocks.cleanup.findMany).not.toHaveBeenCalled();
  expect(mocks.cleanup.updateMany).not.toHaveBeenCalled();
  expect(mocks.resources).not.toHaveBeenCalled();
  expect(mocks.destroy).not.toHaveBeenCalled();
});
it('orphan scan requires a separate opt-in even when deletion is enabled', async () => {
  mocks.env.EVIDENCE_DELETION_ENABLED = true;
  const { sweepOrphanedEvidence } = await import('@/lib/jobs');
  await sweepOrphanedEvidence();
  expect(mocks.resources).not.toHaveBeenCalled();
});
it('an explicit scan only queues in-namespace aged unreferenced assets', async () => {
  mocks.env.EVIDENCE_DELETION_ENABLED = true;
  mocks.env.ORPHAN_EVIDENCE_SWEEP_ENABLED = true;
  const old = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  mocks.resources.mockResolvedValue({ resources: [
    { public_id: 'emergency-incidents/citizen/production', created_at: old },
    { public_id: 'emergency-incidents-staging/citizen/orphan', created_at: old },
    { public_id: 'emergency-incidents-staging/citizen/attached', created_at: old },
    { public_id: 'emergency-incidents-staging/citizen/new', created_at: new Date().toISOString() },
  ] });
  mocks.attachment.findMany.mockResolvedValue([{ publicId: 'emergency-incidents-staging/citizen/attached' }]);
  mocks.transaction.mockImplementation(async (callback) => callback({ assetCleanupJob: mocks.cleanup }));
  const { sweepOrphanedEvidence } = await import('@/lib/jobs');
  await sweepOrphanedEvidence();
  expect(mocks.resources).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'emergency-incidents-staging/' }));
  expect(mocks.cleanup.upsert).toHaveBeenCalledTimes(1);
  expect(mocks.cleanup.upsert.mock.calls[0][0].where.publicId).toBe('emergency-incidents-staging/citizen/orphan');
});
it('never destroys an old cross-environment job even with deletion opted in', async () => {
  mocks.env.EVIDENCE_DELETION_ENABLED = true;
  mocks.cleanup.findMany.mockResolvedValue([{ publicId: 'emergency-incidents/citizen/production', assetCleanupJobId: 'old-job', status: 'PENDING', attempts: 0 }]);
  const { processPendingJobs } = await import('@/lib/jobs');
  await processPendingJobs();
  expect(mocks.destroy).not.toHaveBeenCalled();
  expect(mocks.attachment.findUnique).not.toHaveBeenCalled();
  expect(mocks.cleanup.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', lastError: expect.stringContaining('outside') }) }));
});
it('rejects cleanup enqueue across environment boundaries before writing', async () => {
  const { enqueueAssetCleanup } = await import('@/lib/jobs');
  await expect(enqueueAssetCleanup({ assetCleanupJob: mocks.cleanup } as never, 'emergency-incidents/citizen/production')).rejects.toThrow('outside');
  expect(mocks.cleanup.upsert).not.toHaveBeenCalled();
});
