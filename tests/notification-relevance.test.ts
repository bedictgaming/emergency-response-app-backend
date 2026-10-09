import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), incident: vi.fn(), task: vi.fn(), dispatch: vi.fn(), alert: vi.fn(), acknowledgement: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: mocks.user }, incident: { findUnique: mocks.incident }, task: { findFirst: mocks.task }, incidentUnit: { findFirst: mocks.dispatch }, alert: { findUnique: mocks.alert }, incidentAcknowledgement: { findUnique: mocks.acknowledgement } } }));
import { notificationRelevant, notificationExpiry } from '@/lib/notification-relevance';
const job = () => ({ eventType: 'INCIDENT_CREATED', createdAt: new Date(), userIds: ['staff'], audienceIds: ['staff'], payload: { data: { incidentId: 'incident', attentionVersion: '1', serviceAttentionVersion: '1' } } });
const incident = { incidentId: 'incident', status: 'RESPONDING', verificationStatus: 'VERIFIED', attentionVersion: 1, requestedServices: ['FIRE', 'MEDICAL'], serviceResponses: [{ service: 'FIRE', status: 'RESPONDING', attentionVersion: 1 }, { service: 'MEDICAL', status: 'RESPONDING', attentionVersion: 1 }] };
beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE', department: 'FIRE', isMainAdmin: false }); mocks.incident.mockResolvedValue(incident); });
it('checks current department and excludes unselected admins', async () => {
  expect(await notificationRelevant(job(), 'staff')).toBe(true);
  mocks.user.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE', department: 'POLICE' });
  expect(await notificationRelevant(job(), 'staff')).toBe(false);
});
it.each([{ status: 'RESOLVED' }, { status: 'CLOSED' }, { verificationStatus: 'PENDING' }, { verificationStatus: 'REJECTED' }, { mergedIntoId: 'target' }])('drops irrelevant incident push %j', async changes => {
  mocks.incident.mockResolvedValue({ ...incident, ...changes }); expect(await notificationRelevant(job(), 'staff')).toBe(false);
});
it('drops deleted incidents and department-completed work', async () => {
  mocks.incident.mockResolvedValue(null); expect(await notificationRelevant(job(), 'staff')).toBe(false);
  mocks.incident.mockResolvedValue({ ...incident, serviceResponses: [{ service: 'FIRE', status: 'RESOLVED', attentionVersion: 1 }] }); expect(await notificationRelevant(job(), 'staff')).toBe(false);
});
it('does not confuse an unrelated service reopening with completion of this service', async () => {
  mocks.incident.mockResolvedValue({ ...incident, attentionVersion: 2, serviceResponses: [{ service: 'FIRE', status: 'RESPONDING', attentionVersion: 1 }, { service: 'MEDICAL', status: 'RESPONDING', attentionVersion: 2 }] });
  expect(await notificationRelevant(job(), 'staff')).toBe(true);
});
it('does not redeliver creation for a reopened service but permits the new version', async () => {
  mocks.incident.mockResolvedValue({ ...incident, attentionVersion: 2, serviceResponses: [{ service: 'FIRE', status: 'RESPONDING', attentionVersion: 2 }] });
  expect(await notificationRelevant(job(), 'staff')).toBe(false);
  expect(await notificationRelevant({ ...job(), eventType: 'INCIDENT_REOPENED', payload: { data: { incidentId: 'incident', responseService: 'FIRE', attentionVersion: '2', serviceAttentionVersion: '2' } } }, 'staff')).toBe(true);
});
it('retains the original audience when retry IDs were narrowed after a successful device', async () => {
  expect(await notificationRelevant({ ...job(), userIds: [] }, 'staff')).toBe(true);
});
it('suppresses delayed pushes for this personal acknowledgement but not a later reopened version', async () => {
  mocks.acknowledgement.mockResolvedValue({ version: 1 });
  expect(await notificationRelevant(job(), 'staff')).toBe(false);
  expect(mocks.acknowledgement).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_incidentId_scope: { userId: 'staff', incidentId: 'incident', scope: 'FIRE' } } }));
  mocks.incident.mockResolvedValue({ ...incident, attentionVersion: 2, serviceResponses: [{ service: 'FIRE', status: 'RESPONDING', attentionVersion: 2 }] });
  expect(await notificationRelevant({ ...job(), eventType: 'INCIDENT_REOPENED', payload: { data: { incidentId: 'incident', responseService: 'FIRE', attentionVersion: '2', serviceAttentionVersion: '2' } } }, 'staff')).toBe(true);
});
it('uses the Main department-handoff receipt and does not suppress a new reopened version', async () => {
  mocks.user.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE', department: 'MAIN', isMainAdmin: true });
  mocks.acknowledgement.mockResolvedValue({ version: 1 });
  expect(await notificationRelevant(job(), 'staff')).toBe(false);
  expect(mocks.acknowledgement).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_incidentId_scope: { userId: 'staff', incidentId: 'incident', scope: 'MAIN' } } }));
  mocks.incident.mockResolvedValue({ ...incident, attentionVersion: 2 });
  expect(await notificationRelevant({ ...job(), eventType: 'INCIDENT_REOPENED', payload: { data: { incidentId: 'incident', responseService: 'FIRE', attentionVersion: '2', serviceAttentionVersion: '2' } } }, 'staff')).toBe(true);
});
it('does not turn a database outage into a completed/suppressed notification', async () => {
  mocks.incident.mockRejectedValue(new Error('database unavailable')); await expect(notificationRelevant(job(), 'staff')).rejects.toThrow();
});
it('expires old push hints, not incident records, and leaves verification/public lifetimes distinct', async () => {
  const expired = { ...job(), createdAt: new Date(Date.now() - 16 * 60_000) }; expect(await notificationRelevant(expired, 'staff')).toBe(false); expect(mocks.user).not.toHaveBeenCalled();
  expect(notificationExpiry({ ...expired, eventType: 'INCIDENT_VERIFIED' }).getTime()).toBeGreaterThan(Date.now());
});
it('rechecks task assignee/status and dispatch unit membership', async () => {
  mocks.user.mockResolvedValue({ role: 'RESPONDER', status: 'ACTIVE', responder: { status: 'AVAILABLE', unit: { unitType: 'Fire engine' } } });
  mocks.task.mockResolvedValue(null); mocks.dispatch.mockResolvedValue(null);
  expect(await notificationRelevant({ ...job(), eventType: 'TASK_CREATED', payload: { data: { incidentId: 'incident', taskId: 'task' } } }, 'staff')).toBe(false);
  expect(mocks.task).not.toHaveBeenCalled();
  expect(mocks.incident).not.toHaveBeenCalled();
  expect(await notificationRelevant({ ...job(), eventType: 'UNIT_DISPATCHED', payload: { data: { incidentId: 'incident', dispatchId: 'dispatch' } } }, 'staff')).toBe(false);
});
