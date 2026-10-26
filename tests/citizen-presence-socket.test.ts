import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { io as client, type Socket } from 'socket.io-client';
const db = vi.hoisted(() => ({ account: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: db.account } } }));
import presenceRoutes from '@/routes/citizen-presence.routes';
import { attachSocketEvents, SOCKET_EVENTS_PATH } from '@/lib/socket-events';
import { createApiGatewayGuard } from '@/middleware/api-gateway';
import { originGuard } from '@/middleware/origin-guard';
import { signAccessToken, type JwtPayload } from '@/lib/jwt';

type Actor = { sub: string; sessionId: string; role: JwtPayload['role']; cookie: string };
let server: HttpServer, realtime: ReturnType<typeof attachSocketEvents>, origin: string;
const sockets: Socket[] = [], accounts = new Map<string, Record<string, unknown>>();
function actor(role: JwtPayload['role'] = 'USER'): Actor {
  const sub = randomUUID(), sessionId = randomUUID();
  accounts.set(sub, { id: sub, role, status: 'ACTIVE', department: role === 'USER' ? null : 'FIRE', isMainAdmin: false, tokens: [{ id: sessionId }] });
  return { sub, sessionId, role, cookie: `accessToken=${signAccessToken(sub, role, 900, sessionId)}` };
}
async function connect(identity: Actor) {
  const socket = client(origin, { path: SOCKET_EVENTS_PATH, transports: ['websocket'], reconnection: false, forceNew: true,
    autoConnect: false, timeout: 1500, extraHeaders: { Origin: 'http://localhost:3000', Cookie: identity.cookie } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  expect(socket.io.engine.transport.name).toBe('websocket'); return socket;
}
function post(identity: Actor | null, endpoint: string, body: object, pageOrigin = 'http://localhost:3000') {
  return fetch(`${origin}/api/citizen-presence/v2/${endpoint}`, { method: 'POST', headers: {
    Origin: pageOrigin, 'Content-Type': 'application/json', ...(identity ? { Cookie: identity.cookie } : {}),
  }, body: JSON.stringify({ sharing: 'exact-gps-v1', ...body }) });
}
const heartbeat = (visitId: string, meters = 0) => ({ visitId, latitude: 10.251 + meters / 111_320, longitude: 123.949, accuracy: 15, timestamp: Date.now() });
beforeEach(async () => {
  vi.stubEnv('CITIZEN_PRESENCE_ENABLED', 'true'); vi.resetAllMocks(); accounts.clear();
  db.account.mockImplementation(({ where }) => Promise.resolve(accounts.get(where.id) ?? null));
  const app = express(); app.use(express.json(), cookieParser(), originGuard); app.use('/api/citizen-presence', presenceRoutes);
  server = createServer(app); realtime = attachSocketEvents(server, createApiGatewayGuard({ required: false, secret: '', audience: '' }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Loopback fixture required');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.disconnect());
  if (realtime) await new Promise<void>(resolve => realtime.close(() => resolve()));
  vi.unstubAllEnvs();
});
it('requires active current citizen auth, trusted Origin, strict body, fresh GPS and a real WebSocket', async () => {
  const citizen = actor(), visit = randomUUID();
  expect((await post(null, 'heartbeat', heartbeat(visit))).status).toBe(401);
  expect((await post(actor('ADMIN'), 'heartbeat', heartbeat(visit))).status).toBe(403);
  expect((await post(citizen, 'heartbeat', heartbeat(visit), 'https://hostile.invalid')).status).toBe(403);
  expect((await post(citizen, 'heartbeat', heartbeat(visit))).status).toBe(409);
  await connect(citizen);
  expect((await post(citizen, 'heartbeat', { ...heartbeat(visit), userId: randomUUID() })).status).toBe(400);
  expect((await post(citizen, 'heartbeat', { ...heartbeat(visit), timestamp: Date.now() - 60_001 })).status).toBe(400);
  expect((await post(citizen, 'heartbeat', { ...heartbeat(visit), latitude: 0, longitude: 0 })).status).toBe(400);
  const result = await post(citizen, 'heartbeat', heartbeat(visit));
  expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
  expect(await result.json()).toEqual({ data: { precision: 'exact-gps-v1', radiusMeters: 100, expiresInSeconds: 30, positions: [] } });
});
it('a rotated HTTP session cannot borrow its previous session socket; reconnect restores presence', async () => {
  const citizen = actor(), old = await connect(citizen);
  expect((await post(citizen, 'heartbeat', heartbeat(randomUUID()))).status).toBe(200);
  const sessionId = randomUUID();
  const rotated = { ...citizen, sessionId, cookie: `accessToken=${signAccessToken(citizen.sub, 'USER', 900, sessionId)}` };
  accounts.set(citizen.sub, { id: citizen.sub, role: 'USER', status: 'ACTIVE', department: null, isMainAdmin: false, tokens: [{ id: sessionId }] });
  const denied = await post(rotated, 'heartbeat', heartbeat(randomUUID()));
  expect(denied.status).toBe(409);
  expect(await denied.json()).toEqual({ message: 'A current Socket.IO connection is required' });
  old.disconnect(); await connect(rotated);
  expect((await post(rotated, 'heartbeat', heartbeat(randomUUID()))).status).toBe(200);
});
it('pushes a coordinate-free hint and returns explicitly shared GPS only over HTTP; disconnect removes the dot', async () => {
  const a = actor(), b = actor(), av = randomUUID(), bv = randomUUID();
  const one = await connect(a), two = await connect(b), received = vi.fn(); one.on('emergency.event', received);
  expect((await post(a, 'heartbeat', heartbeat(av))).status).toBe(200);
  expect((await post(b, 'heartbeat', heartbeat(bv, 20))).status).toBe(200);
  await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ type: 'presence.changed' }));
  expect(JSON.stringify(received.mock.calls)).not.toMatch(/latitude|longitude|entityId|occurredAt|sessionId|visitId/);
  expect(JSON.stringify(received.mock.calls)).not.toContain(b.sub);
  expect(await (await post(a, 'nearby', { visitId: av })).json()).toEqual({ data: { precision: 'exact-gps-v1', radiusMeters: 100, expiresInSeconds: 30,
    positions: [{ latitude: heartbeat(bv, 20).latitude, longitude: 123.949, accuracy: 15 }] } });
  expect((await post(a, 'nearby', { visitId: bv })).status).toBe(409);
  received.mockClear();
  // Await the actual pushed packet under the existing test deadline. Presence
  // coalesces for up to1s, the same as vi.waitFor's default deadline.
  const closedHint = new Promise<void>(resolve => one.once('emergency.event', event => {
    expect(event).toEqual({ type: 'presence.changed' }); resolve();
  }));
  two.disconnect(); await closedHint;
  expect((await (await post(a, 'nearby', { visitId: av })).json()).data.positions).toEqual([]);
});
it('automatically pushes entry and exit when an online peer crosses the 100m radius without a report', async () => {
  const a = actor(), b = actor(), av = randomUUID(), bv = randomUUID();
  const one = await connect(a), two = await connect(b);
  const packets: unknown[] = [];
  one.on('emergency.event', packet => packets.push(packet));
  expect((await post(a, 'heartbeat', heartbeat(av))).status).toBe(200);
  expect((await post(b, 'heartbeat', heartbeat(bv, 120))).status).toBe(200);
  expect((await (await post(a, 'nearby', { visitId: av })).json()).data.positions).toEqual([]);
  expect(packets).toEqual([]);

  // No viewer lease renewal, reload or report submission triggers these reads:
  // wait for the actual server WebSocket hint after each peer GPS movement.
  const entry = new Promise<unknown>(resolve => one.once('emergency.event', resolve));
  expect((await post(b, 'heartbeat', heartbeat(bv, 99))).status).toBe(200);
  expect(await entry).toEqual({ type: 'presence.changed' });
  expect((await (await post(a, 'nearby', { visitId: av })).json()).data.positions).toEqual([
    { latitude: heartbeat(bv, 99).latitude, longitude: 123.949, accuracy: 15 },
  ]);

  const exit = new Promise<unknown>(resolve => one.once('emergency.event', resolve));
  expect((await post(b, 'heartbeat', heartbeat(bv, 101))).status).toBe(200);
  expect(await exit).toEqual({ type: 'presence.changed' });
  expect((await (await post(a, 'nearby', { visitId: av })).json()).data.positions).toEqual([]);
  expect(packets).toEqual([{ type: 'presence.changed' }, { type: 'presence.changed' }]);
  expect(one.connected).toBe(true); expect(two.connected).toBe(true);
});

it('pushes successive walking GPS changes and re-evaluates distance when the viewer moves, without a route history', async () => {
  const a = actor(), b = actor(), av = randomUUID(), bv = randomUUID();
  const one = await connect(a), two = await connect(b);
  const packets: unknown[] = []; one.on('emergency.event', event => packets.push(event));
  expect((await post(a, 'heartbeat', heartbeat(av))).status).toBe(200);
  for (const meters of [20, 55, 80]) {
    const pushed = new Promise<unknown>(resolve => one.once('emergency.event', resolve));
    const current = heartbeat(bv, meters); expect((await post(b, 'heartbeat', current)).status).toBe(200);
    expect(await pushed).toEqual({ type: 'presence.changed' });
    const read = await post(a, 'nearby', { visitId: av }); expect(read.headers.get('cache-control')).toBe('no-store');
    expect((await read.json()).data.positions).toEqual([{ latitude: current.latitude, longitude: current.longitude, accuracy: 15 }]);
  }
  for (const [meters, visible] of [[-50, false], [10, true]] as const) {
    const pushed = new Promise<unknown>(resolve => two.once('emergency.event', resolve));
    const result = await post(a, 'heartbeat', heartbeat(av, meters)); expect(result.status).toBe(200);
    expect((await result.json()).data.positions).toHaveLength(visible ? 1 : 0);
    expect(await pushed).toEqual({ type: 'presence.changed' });
    expect((await (await post(b, 'nearby', { visitId: bv })).json()).data.positions).toHaveLength(visible ? 1 : 0);
  }
  expect(packets).toEqual(Array(3).fill({ type: 'presence.changed' }));
  expect(one.connected).toBe(true); expect(two.connected).toBe(true);
});

it('has no client socket commands and preserves current role/session revocation for HTTP presence', async () => {
  const identity = actor(), visit = randomUUID(), socket = await connect(identity);
  expect((await post(identity, 'heartbeat', heartbeat(visit))).status).toBe(200);
  socket.emit('presence.publish', heartbeat(visit));
  await vi.waitFor(() => expect(socket.connected).toBe(false));
  expect((await post(identity, 'heartbeat', heartbeat(visit))).status).toBe(409);
  await connect(identity); accounts.get(identity.sub)!.tokens = [];
  expect((await post(identity, 'heartbeat', heartbeat(visit))).status).toBe(401);
  accounts.get(identity.sub)!.tokens = [{ id: identity.sessionId }]; accounts.get(identity.sub)!.role = 'ADMIN';
  accounts.get(identity.sub)!.department = 'FIRE';
  expect((await post(identity, 'heartbeat', heartbeat(visit))).status).toBe(403);
});
it('explicit leave is idempotent, cannot be revived by a delayed request, and default-off disables writes', async () => {
  const identity = actor(), visit = randomUUID(); await connect(identity);
  expect((await post(identity, 'heartbeat', heartbeat(visit))).status).toBe(200);
  expect((await post(identity, 'leave', { visitId: visit })).status).toBe(204);
  expect((await post(identity, 'leave', { visitId: visit })).status).toBe(204);
  expect((await post(identity, 'heartbeat', heartbeat(visit))).status).toBe(409);
  vi.stubEnv('CITIZEN_PRESENCE_ENABLED', 'false');
  expect((await post(identity, 'heartbeat', heartbeat(randomUUID()))).status).toBe(409);
});

it('requires the new exact-GPS consent version and never upgrades an old approximate v1 client', async () => {
  const identity = actor(), visit = randomUUID(); await connect(identity);
  for (const sharing of [undefined, 'approximate', false]) {
    expect((await post(identity, 'heartbeat', { ...heartbeat(visit), sharing })).status).toBe(400);
    expect((await post(identity, 'nearby', { visitId: visit, sharing })).status).toBe(400);
  }
  const headers = { Origin: 'http://localhost:3000', Cookie: identity.cookie, 'Content-Type': 'application/json' };
  expect(await (await fetch(`${origin}/api/citizen-presence/v1/capability`, { headers })).json()).toEqual({ data: { enabled: false } });
  for (const endpoint of ['heartbeat', 'nearby', 'leave']) {
    const response = await fetch(`${origin}/api/citizen-presence/v1/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(heartbeat(visit)) });
    expect(response.status).toBe(409); expect(await response.text()).not.toMatch(/latitude|longitude|positions/);
  }
  expect((await post(identity, 'nearby', { visitId: visit })).status).toBe(409);
  expect(await (await fetch(`${origin}/api/citizen-presence/v2/capability`, { headers })).json()).toEqual({ data: { enabled: true, precision: 'exact-gps-v1' } });
});
