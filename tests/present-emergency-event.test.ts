import { expect, it, vi } from 'vitest';
const access = vi.hoisted(() => vi.fn());
vi.mock('@/lib/event-access', () => ({ canReceiveEvent: access }));
import { presentEmergencyEvent } from '@/lib/present-emergency-event';
const event = { type: 'incident.created' as const, entityId: 'private-peer-id', occurredAt: 'private-report-time' };
it('presents a Main-only generic user-list hint without account details or a nearby hint', async () => {
  const changed = { ...event, type: 'user.updated' as const, email: 'private@example.invalid', status: 'INACTIVE' };
  access.mockResolvedValue(true);
  expect(await presentEmergencyEvent({ sub: 'main', role: 'ADMIN', type: 'access' }, changed)).toEqual({ type: 'users.changed' });
  access.mockResolvedValue(false);
  expect(await presentEmergencyEvent({ sub: 'citizen', role: 'USER', type: 'access' }, changed)).toBeNull();
});
it('never sends a peer identifier, coordinates or event time in the citizen hint', async () => {
  access.mockResolvedValue(false);
  expect(await presentEmergencyEvent({ sub: 'citizen', role: 'USER', type: 'access' }, event)).toEqual({ type: 'nearby.changed' });
});
it('preserves existing authorized event metadata and rejects unrelated operational events', async () => {
  access.mockResolvedValue(true);
  expect(await presentEmergencyEvent({ sub: 'citizen', role: 'USER', type: 'access' }, event)).toEqual(event);
  access.mockResolvedValue(false);
  expect(await presentEmergencyEvent({ sub: 'staff', role: 'ADMIN', department: 'FIRE', type: 'access' }, event)).toBeNull();
  expect(await presentEmergencyEvent({ sub: 'citizen', role: 'USER', type: 'access' }, { ...event, type: 'task.updated' })).toBeNull();
});
it('whitelists ordinary event metadata even if an internal publisher adds extra fields', async () => {
  access.mockResolvedValue(true);
  const extended = { ...event, description: 'Private body', evidenceUrl: 'private-evidence', reporter: 'private identity' };
  expect(await presentEmergencyEvent({ sub: 'staff', role: 'ADMIN', department: 'MAIN', isMainAdmin: true, type: 'access' }, extended)).toEqual(event);
});
