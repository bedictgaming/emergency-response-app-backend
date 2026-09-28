import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ incident: vi.fn(), task: vi.fn(), dispatch: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { incident: { findFirst: mocks.incident }, task: { findFirst: mocks.task }, incidentUnit: { findFirst: mocks.dispatch } } }));
import { canReceiveEvent } from '@/lib/event-access';
beforeEach(() => vi.resetAllMocks());
it('does not broadcast unrelated incident identifiers to citizens', async () => {
  const actor = { sub: 'citizen', role: 'USER', type: 'access' as const };
  const event = { type: 'incident.created' as const, entityId: 'incident', occurredAt: '' };
  mocks.incident.mockResolvedValue(null);
  expect(await canReceiveEvent(actor, event)).toBe(false);
  expect(mocks.incident.mock.calls[0][0].where).toEqual({ incidentId: 'incident', reportedBy: 'citizen' });
  mocks.incident.mockResolvedValue({ incidentId: 'incident' });
  expect(await canReceiveEvent(actor, event)).toBe(true);
});
it('checks task assignment for responder events', async () => {
  const actor = { sub: 'responder', role: 'RESPONDER', type: 'access' as const };
  expect(await canReceiveEvent(actor, { type: 'task.updated', entityId: 'task', occurredAt: '' })).toBe(false);
  expect(mocks.task.mock.calls[0][0].where.assignee).toEqual({ userId: 'responder' });
});

it('routes an incident event only to its department and the main administrator', async () => {
  const event = { type: 'incident.created' as const, entityId: 'fire-incident', occurredAt: '' };
  mocks.incident.mockImplementation(async ({ where }) => (
    where.OR?.some((condition: { requestedServices?: { has?: string } }) => condition.requestedServices?.has === 'FIRE')
      ? { incidentId: event.entityId }
      : null
  ));

  expect(await canReceiveEvent({ sub: 'fire-admin', role: 'ADMIN', type: 'access', department: 'FIRE', isMainAdmin: false }, event)).toBe(true);
  expect(await canReceiveEvent({ sub: 'medical-admin', role: 'ADMIN', type: 'access', department: 'MEDICAL', isMainAdmin: false }, event)).toBe(false);
  expect(await canReceiveEvent({ sub: 'police-dispatcher', role: 'DISPATCHER', type: 'access', department: 'POLICE', isMainAdmin: false }, event)).toBe(false);
  expect(await canReceiveEvent({ sub: 'hazard-admin', role: 'ADMIN', type: 'access', department: 'DRRMO', isMainAdmin: false }, event)).toBe(false);
  expect(await canReceiveEvent({ sub: 'main-admin', role: 'ADMIN', type: 'access', department: 'MAIN', isMainAdmin: true }, event)).toBe(true);
  expect(mocks.incident).toHaveBeenCalledTimes(4);
});

it('does not send a hazard-only event to Medical, but permits an explicitly shared incident', async () => {
  const medical = { sub: 'medical-admin', role: 'ADMIN', type: 'access' as const, department: 'MEDICAL' as const, isMainAdmin: false };
  const hazard = { sub: 'hazard-admin', role: 'ADMIN', type: 'access' as const, department: 'DRRMO' as const, isMainAdmin: false };
  const event = { type: 'incident.created' as const, entityId: 'hazard-incident', occurredAt: '' };
  let requestedServices = ['HAZARD'];
  mocks.incident.mockImplementation(async ({ where }) => (
    where.OR?.some((condition: { requestedServices?: { has?: string } }) => requestedServices.includes(condition.requestedServices?.has ?? ''))
      ? { incidentId: event.entityId }
      : null
  ));

  expect(await canReceiveEvent(medical, event)).toBe(false);
  expect(await canReceiveEvent(hazard, event)).toBe(true);
  requestedServices = ['HAZARD', 'MEDICAL'];
  expect(await canReceiveEvent(medical, event)).toBe(true);
});

it('scopes shared-incident task and dispatch events to their owning department', async () => {
  const medical = { sub: 'medical-admin', role: 'ADMIN', type: 'access' as const, department: 'MEDICAL' as const, isMainAdmin: false };
  const taskEvent = { type: 'task.updated' as const, entityId: 'hazard-task', occurredAt: '' };
  const dispatchEvent = { type: 'dispatch.updated' as const, entityId: 'hazard-dispatch', occurredAt: '' };
  mocks.task.mockResolvedValue(null);
  mocks.dispatch.mockResolvedValue(null);

  expect(await canReceiveEvent(medical, taskEvent)).toBe(false);
  expect(mocks.task.mock.calls[0][0].where.OR[0].assignee.unit.OR[0].unitType.contains).toBe('medical');
  expect(await canReceiveEvent(medical, dispatchEvent)).toBe(false);
  expect(mocks.dispatch.mock.calls[0][0].where.unit.OR[0].unitType.contains).toBe('medical');
});
