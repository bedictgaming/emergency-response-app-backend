import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import express from 'express';
import { io as client, type Socket } from 'socket.io-client';
const db = vi.hoisted(() => ({ account: vi.fn(), incident: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: db.account }, incident: { findFirst: db.incident } } }));
import { attachSocketEvents, SOCKET_EVENTS_PATH } from '@/lib/socket-events';
import { createApiGatewayGuard } from '@/middleware/api-gateway';
import { signAccessToken, type JwtPayload } from '@/lib/jwt';
import { publishEmergencyEvent } from '@/lib/events';

let server: HttpServer;
let realtime: ReturnType<typeof attachSocketEvents>;
let origin: string;
const clients: Socket[] = [];
const accounts = new Map<string, Record<string, unknown>>();
function actor(role = 'ADMIN', department: string | null = 'MAIN') {
  const sub = randomUUID(), sessionId = randomUUID();
  const value = { sub, sessionId, role, department, isMainAdmin: department === 'MAIN' };
  accounts.set(sub, { ...value, id: sub, status: 'ACTIVE', tokens: [{ id: sessionId }] });
  return value;
}
async function start(required = false) {
  server = createServer(express());
  realtime = attachSocketEvents(server, createApiGatewayGuard({ required,
    secret: 'provider-free-test-gateway-secret-at-least-32', audience: 'socket-test-v1' }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback fixture unavailable');
  origin = `http://127.0.0.1:${address.port}`;
}
function socket(value?: ReturnType<typeof actor>, pageOrigin = 'http://localhost:3000', proof = false) {
  const headers: Record<string, string> = { Origin: pageOrigin };
  if (value) headers.Cookie = `accessToken=${signAccessToken(value.sub, value.role as JwtPayload['role'], 900, value.sessionId)}`;
  if (proof) {
    const time = String(Date.now()), nonce = randomBytes(16).toString('hex');
    const payload = JSON.stringify(['er-api-gateway-v2', 'socket-test-v1', time, nonce, 'GET',
      `${SOCKET_EVENTS_PATH}/?EIO=4&transport=websocket`, '127.0.0.1', headers.Cookie ?? '', '', pageOrigin, '', '', pageOrigin]);
    Object.assign(headers, { 'x-er-gateway-time': time, 'x-er-gateway-nonce': nonce,
      'x-er-gateway-ip': '127.0.0.1', 'x-er-gateway-origin': pageOrigin,
      'x-er-gateway-signature': createHmac('sha256', 'provider-free-test-gateway-secret-at-least-32').update(payload).digest('hex') });
  }
  const result = client(origin, { path: SOCKET_EVENTS_PATH, transports: ['websocket'],
    extraHeaders: headers, autoConnect: false, reconnection: false, timeout: 1500, forceNew: true });
  clients.push(result); return result;
}
async function connected(current: Socket) {
  await new Promise<void>((resolve, reject) => {
    current.once('connect', resolve); current.once('connect_error', reject); current.connect();
  });
}
async function rejected(current: Socket) {
  await new Promise<void>((resolve, reject) => {
    current.once('connect_error', () => resolve()); current.once('connect', () => reject(Error('Unexpected connection'))); current.connect();
  });
}
beforeEach(() => {
  vi.resetAllMocks(); accounts.clear();
  db.account.mockImplementation(({ where }) => Promise.resolve(accounts.get(where.id) ?? null));
  db.incident.mockResolvedValue(null);
});
afterEach(async () => {
  clients.splice(0).forEach(current => current.disconnect());
  if (realtime) await new Promise<void>(resolve => realtime.close(() => resolve()));
});
it('rejects an anonymous real WebSocket connection', async () => {
  await start(); await rejected(socket()); expect(db.account).not.toHaveBeenCalled();
});
it('rejects a hostile WebSocket Origin even with a cookie', async () => {
  await start(); await rejected(socket(actor(), 'https://hostile.invalid')); expect(db.account).not.toHaveBeenCalled();
});
it('does not bypass the required gateway on a real upgrade', async () => {
  await start(true); await rejected(socket(actor())); expect(db.account).not.toHaveBeenCalled();
});
it('accepts the existing v2 gateway proof plus cookie authentication on a real upgrade', async () => {
  await start(true); const current = socket(actor(), 'http://localhost:3000', true);
  await connected(current); expect(current.connected).toBe(true);
});
it('keeps ordinary Engine.IO HTTP handshakes no-store and authenticated too', async () => {
  await start(); const response = await fetch(`${origin}${SOCKET_EVENTS_PATH}/?EIO=4&transport=polling`, {
    headers: { Origin: 'http://localhost:3000' },
  });
  expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(db.account).not.toHaveBeenCalled();
});
it('uses real WebSocket transport and sends only authorized invalidation metadata', async () => {
  await start(); const current = socket(actor()); await connected(current);
  expect(current.io.engine.transport.name).toBe('websocket');
  const received = new Promise(resolve => current.once('emergency.event', resolve));
  const entityId = randomUUID(); publishEmergencyEvent({ type: 'incident.created', entityId });
  expect(await received).toEqual({ type: 'incident.created', entityId, occurredAt: expect.any(String) });
});
it('keeps department and citizen ownership in the real event access query', async () => {
  await start(); const fireActor = actor('ADMIN', 'FIRE'), citizenActor = actor('USER', null);
  const fire = socket(fireActor), citizen = socket(citizenActor);
  await Promise.all([connected(fire), connected(citizen)]);
  const fireReceived = vi.fn(), citizenReceived = vi.fn();
  fire.on('emergency.event', fireReceived); citizen.on('emergency.event', citizenReceived);
  const entityId = randomUUID(); publishEmergencyEvent({ type: 'incident.updated', entityId });
  await vi.waitFor(() => expect(db.incident).toHaveBeenCalledTimes(2));
  expect(db.incident.mock.calls.map(([query]) => query.where)).toEqual(expect.arrayContaining([
    expect.objectContaining({ incidentId: entityId, reportedBy: citizenActor.sub }),
    expect.objectContaining({ incidentId: entityId, OR: expect.arrayContaining([
      { requestedServices: { has: 'FIRE' } },
    ]) }),
  ]));
  expect(fireReceived).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(citizenReceived).toHaveBeenCalledWith({ type: 'nearby.changed' }));
  expect(JSON.stringify(citizenReceived.mock.calls)).not.toContain(entityId);
});
it.each([
  ['FIRE', 'FIRE'], ['MEDICAL', 'MEDICAL'], ['POLICE', 'POLICE'], ['DRRMO', 'HAZARD'],
])('delivers a permitted update to the assigned %s department', async (department, service) => {
  await start(); const identity = actor('ADMIN', department), current = socket(identity);
  await connected(current);
  const entityId = randomUUID();
  db.incident.mockImplementation(({ where }) => Promise.resolve(
    where.incidentId === entityId && where.OR?.some((clause: { requestedServices?: { has?: string } }) => clause.requestedServices?.has === service)
      ? { incidentId: entityId } : null));
  const received = new Promise(resolve => current.once('emergency.event', resolve));
  publishEmergencyEvent({ type: 'incident.updated', entityId });
  expect(await received).toEqual(expect.objectContaining({ type: 'incident.updated', entityId }));
});
it('delivers an update to its reporting citizen without granting staff scope', async () => {
  await start(); const identity = actor('USER', null), current = socket(identity); await connected(current);
  const entityId = randomUUID();
  db.incident.mockImplementation(({ where }) => Promise.resolve(
    where.incidentId === entityId && where.reportedBy === identity.sub ? { incidentId: entityId } : null));
  const received = new Promise(resolve => current.once('emergency.event', resolve));
  publishEmergencyEvent({ type: 'incident.updated', entityId });
  expect(await received).toEqual(expect.objectContaining({ entityId }));
});
it.each(['deactivated', 'revoked', 'reassigned'])('disconnects before sending after authority is %s', async cause => {
  await start(); const identity = actor('ADMIN', 'FIRE'), current = socket(identity); await connected(current);
  const received = vi.fn(); current.on('emergency.event', received);
  accounts.set(identity.sub, { ...accounts.get(identity.sub),
    ...(cause === 'deactivated' ? { status: 'INACTIVE' } : cause === 'revoked' ? { tokens: [] } : { department: 'MEDICAL' }) });
  publishEmergencyEvent({ type: 'incident.updated', entityId: randomUUID() });
  await vi.waitFor(() => expect(current.connected).toBe(false));
  expect(received).not.toHaveBeenCalled(); expect(db.incident).not.toHaveBeenCalled();
});
it('disconnects when current authorization cannot be read instead of trusting cached authority', async () => {
  await start(); const current = socket(actor()); await connected(current);
  const received = vi.fn(); current.on('emergency.event', received);
  db.account.mockRejectedValueOnce(Error('Synthetic database unavailable'));
  publishEmergencyEvent({ type: 'incident.updated', entityId: randomUUID() });
  await vi.waitFor(() => expect(current.connected).toBe(false)); expect(received).not.toHaveBeenCalled();
});
it('rejects client-selected commands and rooms', async () => {
  await start(); const current = socket(actor()); await connected(current);
  current.emit('join', 'MEDICAL'); await vi.waitFor(() => expect(current.connected).toBe(false));
});
it('bounds account connections and recovers capacity after disconnect', async () => {
  await start(); const identity = actor(), opened = Array.from({ length: 6 }, () => socket(identity));
  for (const current of opened) await connected(current);
  await rejected(socket(identity)); opened[0].disconnect();
  await new Promise(resolve => setTimeout(resolve, 30));
  await connected(socket(identity));
});
