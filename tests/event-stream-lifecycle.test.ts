import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const mocks = vi.hoisted(() => ({ user: vi.fn(), access: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: mocks.user } } }));
vi.mock('@/lib/event-access', () => ({ canReceiveEvent: mocks.access }));
vi.mock('@/lib/events', () => ({ subscribeEmergencyEvents: mocks.subscribe }));
import router from '@/routes/event.routes';
const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/v1/stream').route.stack.at(-1).handle;
const actor = { sub: 'staff', role: 'ADMIN', department: 'MAIN', isMainAdmin: true, sessionId: 'session', exp: Math.floor(Date.now() / 1000) + 900 };
function stream(identity = actor) {
  const req = Object.assign(new EventEmitter(), { user: identity });
  const res = Object.assign(new EventEmitter(), { setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(() => true), end: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() });
  handler(req, res); return { req, res, close: () => req.emit('close') };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.user.mockResolvedValue({ ...actor, status: 'ACTIVE', tokens: [{ id: 'session' }] });
  mocks.access.mockResolvedValue(true); mocks.subscribe.mockReturnValue(mocks.unsubscribe);
});
it('rechecks account/session before each event and closes on deactivation or role change', async () => {
  const current = stream(), notify = mocks.subscribe.mock.calls[0][0];
  mocks.user.mockResolvedValue({ ...actor, role: 'USER', status: 'ACTIVE', tokens: [{ id: 'session' }] });
  notify({ type: 'incident.created', entityId: 'private-id' });
  await vi.waitFor(() => expect(current.res.end).toHaveBeenCalled());
  expect(mocks.access).not.toHaveBeenCalled(); expect(current.res.write).toHaveBeenCalledTimes(1); expect(mocks.unsubscribe).toHaveBeenCalledOnce(); current.close();
});
it('terminates a slow/backpressured client instead of accumulating output', async () => {
  const current = stream(), notify = mocks.subscribe.mock.calls[0][0];
  current.res.write.mockReturnValue(false); notify({ type: 'incident.created', entityId: 'id' });
  await vi.waitFor(() => expect(current.res.end).toHaveBeenCalled()); expect(mocks.unsubscribe).toHaveBeenCalledOnce(); current.close();
});
it('limits six active connections per account and releases closed slots', () => {
  const opened = Array.from({ length: 6 }, () => stream()), rejected = stream();
  expect(rejected.res.status).toHaveBeenCalledWith(429); expect(mocks.subscribe).toHaveBeenCalledTimes(6);
  opened[0].close(); const next = stream(); expect(next.res.status).not.toHaveBeenCalled();
  opened.forEach(item => item.close()); next.close();
});
it('SSE sends only a generic nearby hint, never a peer incident identifier', async () => {
  const citizen = { ...actor, role: 'USER' };
  mocks.user.mockResolvedValue({ ...citizen, status: 'ACTIVE', tokens: [{ id: 'session' }] });
  mocks.access.mockResolvedValue(false);
  const current = stream(citizen), notify = mocks.subscribe.mock.calls[0][0];
  notify({ type: 'incident.updated', entityId: 'private-peer-id', occurredAt: 'private-time' });
  await vi.waitFor(() => expect(current.res.write).toHaveBeenCalledTimes(2));
  expect(current.res.write.mock.calls[1][0]).toBe('event: nearby.changed\ndata: {"type":"nearby.changed"}\n\n');
  current.close();
});

it('preserves different pending events while a permission lookup is in flight', async () => {
  let release!: (value: unknown) => void;
  mocks.user.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const current = stream(), notify = mocks.subscribe.mock.calls[0][0];
  const events = ['first', 'second', 'third'].map(entityId => ({ type: 'incident.updated', entityId, occurredAt: 'synthetic' }));
  events.forEach(notify);
  release({ ...actor, status: 'ACTIVE', tokens: [{ id: 'session' }] });
  await vi.waitFor(() => expect(current.res.write).toHaveBeenCalledTimes(4));
  expect(current.res.write.mock.calls.slice(1).map(([frame]) => JSON.parse(frame.split('data: ')[1]))).toEqual(events);
  current.close();
});

it('bounds pending events and closes on overflow so the client can re-read on reconnect', async () => {
  let release!: (value: unknown) => void;
  mocks.user.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const current = stream(), notify = mocks.subscribe.mock.calls[0][0];
  for (let index = 0; index < 18; index++) notify({ type: 'incident.updated', entityId: String(index) });
  expect(current.res.end).toHaveBeenCalledOnce();
  release({ ...actor, status: 'ACTIVE', tokens: [{ id: 'session' }] });
  await Promise.resolve(); await Promise.resolve();
  expect(current.res.write).toHaveBeenCalledTimes(1);
  current.close();
});

it('SSE emits a generic users.changed and rechecks deactivation without a heartbeat', async () => {
  const current = stream(), notify = mocks.subscribe.mock.calls[0][0];
  notify({ type: 'user.updated', entityId: 'private-citizen', occurredAt: 'private-time' });
  await vi.waitFor(() => expect(current.res.write).toHaveBeenCalledTimes(2));
  expect(current.res.write.mock.calls[1][0]).toBe('event: users.changed\ndata: {"type":"users.changed"}\n\n');
  mocks.user.mockResolvedValue({ ...actor, status: 'INACTIVE', tokens: [] });
  notify({ type: 'user.updated', entityId: actor.sub });
  await vi.waitFor(() => expect(current.res.end).toHaveBeenCalledOnce());
  expect(current.res.write).toHaveBeenCalledTimes(2); current.close();
});
