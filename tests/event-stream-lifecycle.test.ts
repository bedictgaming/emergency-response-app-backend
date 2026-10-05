import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const mocks = vi.hoisted(() => ({ user: vi.fn(), access: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: mocks.user } } }));
vi.mock('@/lib/event-access', () => ({ canReceiveEvent: mocks.access }));
vi.mock('@/lib/events', () => ({ subscribeEmergencyEvents: mocks.subscribe }));
import router from '@/routes/event.routes';
const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/v1/stream').route.stack.at(-1).handle;
const actor = { sub: 'staff', role: 'ADMIN', department: 'MAIN', isMainAdmin: true, sessionId: 'session', exp: Math.floor(Date.now() / 1000) + 900 };
function stream() {
  const req = Object.assign(new EventEmitter(), { user: actor });
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
  const opened = Array.from({ length: 6 }, stream), rejected = stream();
  expect(rejected.res.status).toHaveBeenCalledWith(429); expect(mocks.subscribe).toHaveBeenCalledTimes(6);
  opened[0].close(); const next = stream(); expect(next.res.status).not.toHaveBeenCalled();
  opened.forEach(item => item.close()); next.close();
});
