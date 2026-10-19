import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ find: vi.fn(), remove: vi.fn(), publish: vi.fn() }));
vi.mock('@/repositories/task.repository', () => ({ TaskRepository: class { findById = mocks.find; delete = mocks.remove; } }));
vi.mock('@/lib/events', () => ({ publishEmergencyEvent: mocks.publish }));
import { DeleteTaskService } from '@/services/task/delete-task-service';
beforeEach(() => vi.resetAllMocks());
it('invalidates the still-authorizable parent only after a task is deleted', async () => {
  mocks.find.mockResolvedValue({ taskId: 'task', incidentId: 'parent' });
  mocks.remove.mockImplementation(async () => { expect(mocks.publish).not.toHaveBeenCalled(); });
  expect((await DeleteTaskService('task')).code).toBe(200);
  expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({ type: 'incident.updated', entityId: 'parent' });
});
it.each(['missing', 'failed'])('does not publish when deletion is %s', async cause => {
  mocks.find.mockResolvedValue(cause === 'missing' ? null : { taskId: 'task', incidentId: 'parent' });
  mocks.remove.mockRejectedValue(new Error('Synthetic delete failure'));
  expect((await DeleteTaskService('task')).code).toBe(cause === 'missing' ? 404 : 500);
  expect(mocks.publish).not.toHaveBeenCalled();
});
