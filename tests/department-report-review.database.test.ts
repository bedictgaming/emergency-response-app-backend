import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app, { gatewayGuard } from '@/app';
import { createServer } from 'node:http';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { attachSocketEvents, SOCKET_EVENTS_PATH } from '@/lib/socket-events';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { signAccessToken, type JwtPayload } from '@/lib/jwt';
import type { Department, IncidentReviewFlag, ResponseService } from '@/generated/prisma';
import { FlagIncidentService, FlagNearbyReview, ListIncidentReviewFlagsService, ReviewIncidentFlagService, CorrectIncidentFlagService } from '@/services/incident/review-incident-service';
import { CancelFalseIncidentService } from '@/services/incident/cancel-false-incident-service';
import { DecideNearbyReview } from '@/services/incident/nearby-review-service';
import { UserViolationSummary } from '@/services/user/account-safety-service';
import { UpdateUserStatusService } from '@/services/user/update-user-status-service';
import { wholeReportConfirmedFalse, wholeFalseWhere, wholeFalseAttentionSql } from '@/domain/report-review.policy';
import { Prisma } from '@/generated/prisma';
import { UpdateServiceResponseService } from '@/services/incident/update-service-response-service';
import { ListNearbyReviews, StartNearbyResponse } from '@/services/incident/nearby-review-service';
import { listIncidentAttention } from '@/services/incident/incident-attention-service';
import { verifiedAnalyticsEligibility } from '@/domain/verified-analytics.policy';
import { GetIncidentService } from '@/services/incident/get-incident-service';
import { CitizenReviewNotifications } from '@/services/user/citizen-review-notifications-service';
const enabled = process.env.RUN_NATIVE_DEPARTMENT_REVIEW === '1';
const users: string[] = [];
let typeId: string, locationId: string, safe = false;
const notes = 'Synthetic assessment after contacting the reporter and checking the incident.';
type WireEvent = { type: string; entityId?: string; occurredAt?: string };
async function withCitizenSockets(owner: JwtPayload, other: JwtPayload,
  run: (url: string, ownEvents: WireEvent[], peerEvents: WireEvent[]) => Promise<void>) {
  const server = createServer(app), realtime = attachSocketEvents(server, gatewayGuard), sockets: Socket[] = [];
  const ownEvents: WireEvent[] = [], peerEvents: WireEvent[] = [];
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('SYNTHETIC_SOCKET_TARGET_REQUIRED');
    const url = `http://127.0.0.1:${address.port}`;
    await Promise.all([owner, other].map(async (by, index) => {
      const socket = connectSocket(url, { path: SOCKET_EVENTS_PATH, transports: ['websocket'], autoConnect: false,
        reconnection: false, forceNew: true, timeout: 1500, extraHeaders: { Origin: 'http://localhost:3000',
          Cookie: `accessToken=${signAccessToken(by.sub, by.role, '15m', by.sessionId!)}` } });
      sockets.push(socket); socket.on('emergency.event', (value: WireEvent) => (index ? peerEvents : ownEvents).push(value));
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
      expect(socket.io.engine.transport.name).toBe('websocket');
    }));
    await run(url, ownEvents, peerEvents);
  } finally {
    sockets.forEach(socket => socket.disconnect());
    await new Promise<void>(resolve => realtime.close(() => resolve()));
  }
}
async function nativeReviewRequest(url: string, by: JwtPayload, path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${path}`, { method, headers: { Origin: 'http://localhost:3000',
    Cookie: `accessToken=${signAccessToken(by.sub, by.role, '15m', by.sessionId!)}`,
    ...(body !== undefined && { 'Content-Type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
}
async function actor(department: Department | null = null, role = department ? 'ADMIN' : 'USER'): Promise<JwtPayload> {
  const id = randomUUID(); users.push(id);
  await prisma.user.create({ data: { id, email: `${id}@example.invalid`, name: 'Synthetic department review', role: role as 'ADMIN' | 'USER' | 'DISPATCHER', department, isMainAdmin: department === 'MAIN' } });
  const token = await prisma.token.create({ data: { userId: id, type: 'REFRESH', token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
  return { sub: id, role, type: 'access', sessionId: token.id, department, isMainAdmin: department === 'MAIN' };
}
async function report(owner: JwtPayload, services: ResponseService[] = ['FIRE']) {
  return prisma.incident.create({ data: { title: 'Synthetic department report, not an emergency', reportedBy: owner.sub, typeId, locationId, latitude: 10.251, longitude: 123.949,
    status: 'RESPONDING', verificationStatus: 'VERIFIED', severityLevel: 'MEDIUM', requestedServices: services,
    serviceResponses: { create: services.map(service => ({ service, status: 'RESPONDING' })) } } });
}
async function flag(id: string, by: JwtPayload) { const result = await FlagIncidentService(id, notes, by); expect(result.code).toBe(200); return result.data!.flag; }
const decide = (f: IncidentReviewFlag, by: JwtPayload, status: 'CONFIRMED' | 'DISMISSED' = 'CONFIRMED') => ReviewIncidentFlagService(f.incidentId, f.reviewFlagId, { status, reviewNotes: notes, expectedUpdatedAt: f.updatedAt.toISOString() }, by);
async function count(user: JwtPayload, main: JwtPayload) { const result = await UserViolationSummary(user.sub, main); expect(result.code).toBe(200); return result.data!.confirmedFalseCount; }
async function assessment(id: string) {
  const row = await prisma.incident.findUniqueOrThrow({ where: { incidentId: id }, include: { reviewFlags: true, serviceResponses: true } });
  const policy = wholeReportConfirmedFalse(row, true);
  const [attention] = await prisma.$queryRaw<Array<{ confirmed: boolean }>>(Prisma.sql`SELECT ${wholeFalseAttentionSql(true)} AS confirmed FROM incidents i WHERE i.incident_id=${id}::uuid`);
  expect(attention.confirmed).toBe(policy);
  expect(await prisma.incident.count({ where: { AND: [{ incidentId: id }, wholeFalseWhere(true)] } })).toBe(policy ? 1 : 0);
  expect(await prisma.incident.count({ where: { AND: [{ incidentId: id }, verifiedAnalyticsEligibility(true)] } })).toBe(policy || row.status === 'CANCELLED' ? 0 : 1);
  return policy;
}
const version = (row: Awaited<ReturnType<typeof report>>, f: IncidentReviewFlag) => ({ reason: notes, reviewFlagId: f.reviewFlagId, expectedReviewUpdatedAt: f.updatedAt.toISOString(), expectedIncidentUpdatedAt: row.updatedAt.toISOString() });
async function reviewPages(by: JwtPayload, view: 'pending' | 'reviewed') {
  const first = await ListIncidentReviewFlagsService(1, by, view); expect(first.code).toBe(200);
  const flags = [...first.data!.flags];
  for (let page = 2; page <= first.data!.pagination.pages; page++) {
    const next = await ListIncidentReviewFlagsService(page, by, view); expect(next.code).toBe(200); flags.push(...next.data!.flags);
  }
  return { flags, total: first.data!.pagination.total };
}
describe.runIf(enabled)('native department-owned report review', () => {
  const reports = (by: JwtPayload, query: Record<string, string | number> = {}) => request(app).get('/api/incidents/v1/').query({ includeReviewFlags: 'true', ...query })
    .set('Cookie', `accessToken=${signAccessToken(by.sub, by.role, '15m', by.sessionId!)}`);
  beforeAll(async () => {
    const url = new URL(process.env.DISPOSABLE_DATABASE_URL || '');
    if (url.hostname !== '127.0.0.1' || url.port !== '55433' || url.pathname !== '/alert_disposable' || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
      || process.env.DATABASE_URL !== process.env.DISPOSABLE_DATABASE_URL || process.env.DIRECT_URL !== process.env.DISPOSABLE_DATABASE_URL
      || process.env.DEPARTMENT_REPORT_REVIEW_ENABLED !== 'true' || process.env.CONFIRMED_FALSE_SANCTIONS_ENABLED !== 'true'
      || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED || ENV.API_GATEWAY_REQUIRED || ENV.CLOUDINARY.API_SECRET || ENV.WEB_PUSH_PRIVATE_KEY || ENV.SMTP.PASS
      || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED) throw Error('ISOLATED_NATIVE_DEPARTMENT_TARGET_REQUIRED');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`)[0].name).toBe('alert_disposable');
    safe = true;
    typeId = (await prisma.incidentType.create({ data: { typeName: `Synthetic Fire department ${randomUUID()}` } })).typeId;
    locationId = (await prisma.location.create({ data: { locationName: 'Synthetic only' } })).locationId;
  });
  afterAll(async () => {
    if (safe) {
      await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: users } }, { entityType: 'User', entityId: { in: users } }] } });
      await prisma.incidentNearbyReview.deleteMany({ where: { incident: { reportedBy: { in: users } } } });
      await prisma.incident.deleteMany({ where: { reportedBy: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.location.delete({ where: { locationId } }); await prisma.incidentType.delete({ where: { typeId } });
    }
    await prisma.$disconnect();
  });
  it.each([['FIRE','FIRE'], ['MEDICAL','MEDICAL'], ['POLICE','POLICE'], ['DRRMO','HAZARD']] as const)('%s owns its queue and decision; Main monitors only', async (department, service) => {
    const owner = await actor(), main = await actor('MAIN'), admin = await actor(department), foreign = await actor(department === 'FIRE' ? 'MEDICAL' : 'FIRE');
    const row = await report(owner, [service]), f = await flag(row.incidentId, admin);
    const cookie = (a: JwtPayload) => `accessToken=${signAccessToken(a.sub, a.role, '15m', a.sessionId!)}`;
    const queue = await request(app).get('/api/incidents/v1/review-flags').set('Cookie', cookie(admin));
    expect(queue.status).toBe(200); expect(queue.body.data.canReview).toBe(true); expect(queue.body.data.flags.map((r: { reviewFlagId: string }) => r.reviewFlagId)).toContain(f.reviewFlagId);
    expect((await ListIncidentReviewFlagsService(1, foreign)).data?.flags.map(r => r.reviewFlagId)).not.toContain(f.reviewFlagId);
    const monitor = await ListIncidentReviewFlagsService(1, main); expect(monitor.code).toBe(200); expect(monitor.data?.canReview).toBe(false);
    expect((await flagDenied(row.incidentId, main))).toBe(403);
    expect((await decide(f, main)).code).toBe(403); expect((await decide(f, foreign)).code).toBe(403);
    expect((await decide(f, { ...admin, role: 'DISPATCHER' })).code).toBe(403);
    expect((await decide(f, owner)).code).toBe(403);
    const saved = await decide(f, admin); expect(saved.code).toBe(200); expect(saved.data?.flag.reviewAuthority).toBe('DEPARTMENT');
    expect(await assessment(row.incidentId)).toBe(true); expect(await count(owner, main)).toBe(1);
    const detail = await GetIncidentService(row.incidentId, department, department);
    expect(detail.data?.incident.reportReview).toMatchObject({ canReview: true, wholeConfirmedFalse: true });
    const mainDetail = await GetIncidentService(row.incidentId, 'ALL', 'ALL');
    expect(mainDetail.data?.incident.reportReview).toMatchObject({ canReview: false, canCancelFalse: false, readOnly: true });
    expect((await CancelFalseIncidentService(row.incidentId, version(row, saved.data!.flag), main)).code).toBe(403);
  });
  it('notifies only the owner of saved ordinary/nearby flags, without staff notes or duplicate retries', async () => {
    const owner = await actor(), other = await actor(), fire = await actor('FIRE'), row = await report(owner);
    const saved = await flag(row.incidentId, fire); await flag(row.incidentId, fire);
    const own = await CitizenReviewNotifications(owner); expect(own.code).toBe(200); expect(own.data?.items).toHaveLength(1);
    expect(own.data?.items[0]).toMatchObject({ id: saved.reviewFlagId, incidentId: row.incidentId, department: 'FIRE', status: 'PENDING' });
    expect(Object.keys(own.data!.items[0]).sort()).toEqual(['department','id','incidentId','reportTitle','status','updatedAt']);
    expect(JSON.stringify(own.data)).not.toContain(notes); expect(JSON.stringify(own.data)).not.toContain(fire.sub);
    expect((await CitizenReviewNotifications(other)).data?.items).toEqual([]);
    const parent = await report(other), later = await report(owner);
    const intake = await prisma.incidentNearbyReview.create({ data: { incidentId: later.incidentId, parentIncidentId: parent.incidentId, service: 'FIRE' } });
    expect((await FlagNearbyReview(intake.reviewId, 1, notes, fire)).code).toBe(200);
    expect((await CitizenReviewNotifications(owner)).data?.items).toHaveLength(2);
    expect(await prisma.incidentNearbyResponseStart.count({ where: { reviewId: intake.reviewId } })).toBe(0);
  });
  it('serves private current review status through the real citizen HTTP route, not public alerts', async () => {
    const owner = await actor(), main = await actor('MAIN'), fire = await actor('FIRE'), row = await report(owner), f = await flag(row.incidentId, fire);
    const cookie = (by: JwtPayload) => `accessToken=${signAccessToken(by.sub, by.role, '15m', by.sessionId!)}`;
    expect((await request(app).get('/api/notifications/v1/report-reviews')).status).toBe(401);
    expect((await request(app).get('/api/notifications/v1/report-reviews').set('Cookie', cookie(main))).status).toBe(403);
    expect((await request(app).get('/api/notifications/v1/report-reviews?userId=someone-else').set('Cookie', cookie(owner))).status).toBe(400);
    const read = await request(app).get('/api/notifications/v1/report-reviews').set('Cookie', cookie(owner));
    expect(read.status).toBe(200); expect(read.headers['cache-control']).toBe('no-store'); expect(read.body.data.items[0].status).toBe('PENDING');
    expect((await decide(f, fire)).code).toBe(200);
    const decision = await CitizenReviewNotifications(owner); expect(decision.data?.items[0].status).toBe('CONFIRMED');
    const current = await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { reviewFlagId: f.reviewFlagId } });
    expect((await CorrectIncidentFlagService(row.incidentId, f.reviewFlagId, { reviewNotes: notes, expectedUpdatedAt: current.updatedAt.toISOString() }, fire)).code).toBe(200);
    expect((await CitizenReviewNotifications(owner)).data?.items[0].status).toBe('DISMISSED');
  });
  it.each([['FIRE','FIRE'], ['MEDICAL','MEDICAL'], ['POLICE','POLICE'], ['DRRMO','HAZARD']] as const)('%s flag/review/correction reaches only its citizen over real HTTP, PostgreSQL and WebSocket', async (department, service) => {
    const owner = await actor(), other = await actor(), admin = await actor(department), foreign = await actor(department === 'FIRE' ? 'MEDICAL' : 'FIRE');
    const row = await report(owner, [service]);
    await withCitizenSockets(owner, other, async (url, ownEvents, peerEvents) => {
      const feed = () => nativeReviewRequest(url, owner, '/notifications/v1/report-reviews');
      expect((await feed()).body.data.items).toEqual([]);
      // Denied writes never invent a saved flag or emit a notification.
      expect((await nativeReviewRequest(url, foreign, `/incidents/v1/${row.incidentId}/review-flags`, 'POST', { reason: notes })).status).toBe(403);
      expect(await prisma.incidentReviewFlag.count({ where: { incidentId: row.incidentId } })).toBe(0);
      expect(ownEvents).toEqual([]); expect(peerEvents).toEqual([]);
      const saved = await nativeReviewRequest(url, admin, `/incidents/v1/${row.incidentId}/review-flags`, 'POST', { reason: notes });
      expect(saved.status).toBe(200); const f = saved.body.data.flag;
      for (const [stage, status] of ['PENDING', 'CONFIRMED', 'DISMISSED'].entries()) {
        if (stage) {
          const current = await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { reviewFlagId: f.reviewFlagId } });
          const base = `/incidents/v1/${row.incidentId}/review-flags/${f.reviewFlagId}`;
          const decision = await nativeReviewRequest(url, admin, stage === 1 ? base : `${base}/correction`, stage === 1 ? 'PATCH' : 'POST',
            { ...(stage === 1 && { status: 'CONFIRMED' }), reviewNotes: notes, expectedUpdatedAt: current.updatedAt.toISOString() });
          expect(decision.status).toBe(200);
        }
        // Read only AFTER a real packet, not a fallback timer or page reload.
        await expect.poll(() => ownEvents.length, { timeout: 5000 }).toBe(stage + 1);
        await expect.poll(() => peerEvents.length, { timeout: 5000 }).toBe(stage + 1);
        expect(ownEvents[stage]).toEqual({ type: 'incident.updated', entityId: row.incidentId, occurredAt: expect.any(String) });
        expect(peerEvents[stage]).toEqual({ type: 'nearby.changed' });
        const fresh = await feed(); expect(fresh.status).toBe(200); expect(fresh.cache).toBe('no-store');
        expect(fresh.body.data.items).toHaveLength(1);
        expect(fresh.body.data.items[0]).toMatchObject({ id: f.reviewFlagId, incidentId: row.incidentId, department, status });
        expect(Object.keys(fresh.body.data.items[0]).sort()).toEqual(['department','id','incidentId','reportTitle','status','updatedAt']);
        expect(JSON.stringify(fresh.body.data)).not.toContain(notes); expect(JSON.stringify(fresh.body.data)).not.toContain(admin.sub);
        expect((await nativeReviewRequest(url, other, '/notifications/v1/report-reviews')).body.data.items).toEqual([]);
      }
      expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: row.incidentId } })).status).toBe('RESPONDING');
    });
  });
  it('a quiet pending B flag reaches its own citizen immediately without admission or a response start', async () => {
    const owner = await actor(), other = await actor(), medical = await actor('MEDICAL');
    const parent = await report(other, ['MEDICAL']), later = await report(owner, ['MEDICAL']);
    const review = await prisma.incidentNearbyReview.create({ data: { incidentId: later.incidentId, parentIncidentId: parent.incidentId, service: 'MEDICAL' } });
    await withCitizenSockets(owner, other, async (url, ownEvents) => {
      const saved = await nativeReviewRequest(url, medical, `/incidents/v1/nearby-reviews/${review.reviewId}/flag`, 'POST', { version: 1, reason: notes });
      expect(saved.status).toBe(200);
      await expect.poll(() => ownEvents.length, { timeout: 5000 }).toBe(1);
      expect(ownEvents[0]).toMatchObject({ type: 'incident.updated', entityId: later.incidentId });
      const feed = await nativeReviewRequest(url, owner, '/notifications/v1/report-reviews');
      expect(feed.status).toBe(200); expect(feed.body.data.items[0]).toMatchObject({ incidentId: later.incidentId, department: 'MEDICAL', status: 'PENDING' });
      expect((await prisma.incidentNearbyReview.findUniqueOrThrow({ where: { reviewId: review.reviewId } })).status).toBe('PENDING');
      expect(await prisma.incidentNearbyResponseStart.count({ where: { reviewId: review.reviewId } })).toBe(0);
    });
  });
  it('rechecks citizen session, status and role before reading notifications', async () => {
    const owner = await actor(), fire = await actor('FIRE'); await flag((await report(owner)).incidentId, fire);
    expect((await CitizenReviewNotifications({ ...owner, exp: 0 })).code).toBe(403);
    await prisma.token.update({ where: { id: owner.sessionId }, data: { revokedAt: new Date() } }); expect((await CitizenReviewNotifications(owner)).code).toBe(403);
    await prisma.token.update({ where: { id: owner.sessionId }, data: { revokedAt: null } });
    await prisma.user.update({ where: { id: owner.sub }, data: { status: 'INACTIVE' } }); expect((await CitizenReviewNotifications(owner)).code).toBe(403);
    await prisma.user.update({ where: { id: owner.sub }, data: { status: 'ACTIVE', role: 'ADMIN', department: 'FIRE' } }); expect((await CitizenReviewNotifications(owner)).code).toBe(403);
  });
  it('bounds the owner feed at50 latest distinct review rows with stable descending order', async () => {
    const owner = await actor(), fire = await actor('FIRE');
    const rows = await Promise.all(Array.from({ length: 51 }, () => report(owner)));
    await prisma.incidentReviewFlag.createMany({ data: rows.map((row, index) => ({ incidentId: row.incidentId, department: 'FIRE', flaggedBy: fire.sub, reason: notes,
      updatedAt: new Date(Date.UTC(2026, 9, 23, 0, index)) })) });
    const result = await CitizenReviewNotifications(owner); expect(result.code).toBe(200); expect(result.data?.items).toHaveLength(50); expect(result.data?.hasMore).toBe(true);
    expect(result.data?.items[0].incidentId).toBe(rows[50].incidentId); expect(result.data?.items.at(-1)?.incidentId).toBe(rows[1].incidentId);
    expect(new Set(result.data?.items.map(item => item.id)).size).toBe(50);
  });
  it('separates pending and completed records before pagination/count without changing department scope', async () => {
    const owner = await actor(), fire = await actor('FIRE'), medical = await actor('MEDICAL'), main = await actor('MAIN');
    const beforePending = await reviewPages(fire, 'pending'), beforeReviewed = await reviewPages(fire, 'reviewed');
    const row = await report(owner), pending = await flag(row.incidentId, fire), other = await flag((await report(owner, ['MEDICAL'])).incidentId, medical);
    expect((await reviewPages(fire, 'pending')).total).toBe(beforePending.total + 1);
    expect((await decide(pending, fire, 'DISMISSED')).code).toBe(200);
    const waiting = await reviewPages(fire, 'pending'), completed = await reviewPages(fire, 'reviewed');
    expect(waiting.total).toBe(beforePending.total); expect(completed.total).toBe(beforeReviewed.total + 1);
    expect(waiting.flags.map(item => item.reviewFlagId)).not.toContain(pending.reviewFlagId);
    expect(completed.flags.map(item => item.reviewFlagId)).toContain(pending.reviewFlagId);
    expect(completed.flags.every(item => item.department === 'FIRE' && item.status !== 'PENDING')).toBe(true);
    expect(completed.flags.map(item => item.reviewFlagId)).not.toContain(other.reviewFlagId);
    const monitored = await ListIncidentReviewFlagsService(1, main, 'reviewed'); expect(monitored.data?.canReview).toBe(false);
    expect((await reviewPages(main, 'pending')).flags.map(item => item.reviewFlagId)).toContain(other.reviewFlagId);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: row.incidentId } })).status).toBe('RESPONDING');
  });
  it('paginates completed reviews newest-first, including retained cancelled records and only minimal reviewer profiles', async () => {
    const owner = await actor(), fire = await actor('FIRE');
    const rows = await Promise.all(Array.from({ length: 23 }, () => report(owner)));
    await prisma.incident.update({ where: { incidentId: rows[22].incidentId }, data: { status: 'CANCELLED' } });
    await prisma.incidentReviewFlag.createMany({ data: rows.map((row, index) => ({ incidentId: row.incidentId, department: 'FIRE', flaggedBy: fire.sub,
      reviewedBy: fire.sub, reviewAuthority: 'DEPARTMENT', status: index % 2 ? 'CONFIRMED' : 'DISMISSED', reason: notes, reviewNotes: notes,
      reviewedAt: new Date(Date.UTC(2030, 0, 1, 0, index)), updatedAt: new Date(Date.UTC(2030, 0, 1, 0, 30 - index)) })) });
    const first = await ListIncidentReviewFlagsService(1, fire, 'reviewed'), next = await ListIncidentReviewFlagsService(2, fire, 'reviewed');
    expect(first.data?.view).toBe('reviewed'); expect(first.data?.flags).toHaveLength(20); expect(first.data?.pagination.limit).toBe(20);
    expect(first.data?.flags.map(item => item.incidentId)).toEqual(rows.slice(3).reverse().map(row => row.incidentId));
    expect(next.data?.flags.slice(0, 3).map(item => item.incidentId)).toEqual(rows.slice(0, 3).reverse().map(row => row.incidentId));
    expect(first.data?.flags[0].incident.status).toBe('CANCELLED'); expect(first.data?.flags[0].reviewNotes).toBe(notes);
    expect(Object.keys(first.data!.flags[0].reviewer!).sort()).toEqual(['id','name']);
    const ids = new Set(first.data!.flags.map(item => item.reviewFlagId)); expect(next.data!.flags.every(item => !ids.has(item.reviewFlagId))).toBe(true);
  });
  it('validates real review-view HTTP queries and refuses citizen, dispatcher and revoked sessions', async () => {
    const fire = await actor('FIRE'), citizen = await actor(), dispatcher = await actor('FIRE', 'DISPATCHER');
    const cookie = (by: JwtPayload) => `accessToken=${signAccessToken(by.sub, by.role, '15m', by.sessionId!)}`;
    for (const query of ['view=unknown', 'view=reviewed&view=pending', 'view=reviewed&page=0', 'view=reviewed&department=MEDICAL'])
      expect((await request(app).get(`/api/incidents/v1/review-flags?${query}`).set('Cookie', cookie(fire))).status).toBe(400);
    const result = await request(app).get('/api/incidents/v1/review-flags?view=reviewed').set('Cookie', cookie(fire));
    expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store'); expect(result.body.data.view).toBe('reviewed');
    expect(result.body.data.flags.every((item: IncidentReviewFlag) => item.department === 'FIRE' && item.status !== 'PENDING')).toBe(true);
    for (const by of [citizen, dispatcher]) expect((await request(app).get('/api/incidents/v1/review-flags?view=reviewed').set('Cookie', cookie(by))).status).toBe(403);
    await prisma.token.update({ where: { id: fire.sessionId }, data: { revokedAt: new Date() } });
    expect((await ListIncidentReviewFlagsService(1, fire, 'reviewed')).code).toBe(403);
  });
  it('returns a reflag to Pending while retaining the original completed assessment in audit history', async () => {
    const owner = await actor(), fire = await actor('FIRE'), row = await report(owner), saved = await flag(row.incidentId, fire);
    expect((await decide(saved, fire, 'DISMISSED')).code).toBe(200);
    expect((await reviewPages(fire, 'reviewed')).flags.map(item => item.reviewFlagId)).toContain(saved.reviewFlagId);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: row.incidentId, action: 'INCIDENT_FLAG_REVIEWED' } });
    const reflag = await flag(row.incidentId, fire); expect(reflag.reviewFlagId).toBe(saved.reviewFlagId);
    expect((await reviewPages(fire, 'pending')).flags.map(item => item.reviewFlagId)).toContain(saved.reviewFlagId);
    expect((await reviewPages(fire, 'reviewed')).flags.map(item => item.reviewFlagId)).not.toContain(saved.reviewFlagId);
    expect((await prisma.auditLog.findUniqueOrThrow({ where: { auditLogId: audit.auditLogId } })).metadata).toEqual(audit.metadata);
  });
  it('retains a confirmed false report outside response lists without resolving/cancelling or losing evidence/audits', async () => {
    const owner = await actor(), fire = await actor('FIRE'), main = await actor('MAIN'), police = await actor('POLICE');
    const row = await report(owner);
    await prisma.incidentAcknowledgement.create({ data: { incidentId: row.incidentId, userId: fire.sub, scope: 'FIRE', version: 1 } });
    const before = await reports(fire, { reportView: 'operational', responseService: 'FIRE', serviceStatuses: 'RESPONDING', reportedBy: owner.sub });
    expect(before.status).toBe(200); expect(before.body.data.pagination.total).toBe(1);
    expect((await decide(await flag(row.incidentId, fire), fire)).code).toBe(200);
    expect(await assessment(row.incidentId)).toBe(true);
    const normal = await reports(fire, { reportView: 'operational', responseService: 'FIRE', serviceStatuses: 'RESPONDING', reportedBy: owner.sub });
    expect(normal.status).toBe(200); expect(normal.body.data.incidents).toEqual([]);
    expect(normal.body.data.summary).toMatchObject({ responding: 0, falseReports: 1, total: 1 });
    const retained = await reports(fire, { reportView: 'false-reports', responseService: 'FIRE', reportedBy: owner.sub });
    expect(retained.status).toBe(200); expect(retained.body.data.pagination.total).toBe(1);
    expect(retained.body.data.incidents[0]).toMatchObject({ incidentId: row.incidentId, status: 'RESPONDING', reportReview: { wholeConfirmedFalse: true } });
    expect((await reports(main, { reportView: 'false-reports', reportedBy: owner.sub })).body.data.pagination.total).toBe(1);
    expect((await reports(police, { reportView: 'false-reports', reportedBy: owner.sub })).body.data.pagination.total).toBe(0);
    expect((await reports(owner, { reportView: 'false-reports' })).status).toBe(403);
    expect((await reports(fire, { reportView: 'unknown' })).status).toBe(400);
    expect((await reports(fire, { reportView: 'false-reports', serviceStatuses: 'RESPONDING' })).status).toBe(400);
    expect((await UpdateServiceResponseService(row.incidentId, 'FIRE', 'RESOLVED', fire)).code).toBe(409);
    expect((await listIncidentAttention(main))?.items.some(item => item.incidentId === row.incidentId)).toBe(false);
    const saved = await prisma.incident.findUniqueOrThrow({ where: { incidentId: row.incidentId }, include: { serviceResponses: true, reviewFlags: true } });
    expect(saved.status).toBe(row.status); expect(saved.updatedAt).toEqual(row.updatedAt);
    expect(saved.serviceResponses[0]).toMatchObject({ status: 'RESPONDING', resolvedAt: null, resolvedBy: null });
    expect(await prisma.auditLog.count({ where: { entityId: row.incidentId, action: { in: ['SERVICE_RESPONSE_UPDATED', 'INCIDENT_CANCELLED_FALSE'] } } })).toBe(0);
    expect(await prisma.incidentReviewFlag.count({ where: { incidentId: row.incidentId, status: 'CONFIRMED' } })).toBe(1);
  });
  it('moves only complete consensus and restores the original response view after a correction', async () => {
    const owner = await actor(), fire = await actor('FIRE'), medical = await actor('MEDICAL');
    const row = await report(owner, ['FIRE', 'MEDICAL']);
    await prisma.incidentAcknowledgement.createMany({ data: [{ incidentId: row.incidentId, userId: fire.sub, scope: 'FIRE', version: 1 }, { incidentId: row.incidentId, userId: medical.sub, scope: 'MEDICAL', version: 1 }] });
    const f = await decide(await flag(row.incidentId, fire), fire); expect(f.code).toBe(200);
    expect((await reports(fire, { reportView: 'false-reports', reportedBy: owner.sub })).body.data.pagination.total).toBe(0);
    expect((await reports(fire, { reportView: 'operational', reportedBy: owner.sub })).body.data.incidents.map((item: { incidentId: string }) => item.incidentId)).toEqual([row.incidentId]);
    expect((await decide(await flag(row.incidentId, medical), medical)).code).toBe(200);
    expect(await assessment(row.incidentId)).toBe(true);
    expect((await reports(medical, { reportView: 'false-reports', reportedBy: owner.sub })).body.data.pagination.total).toBe(1);
    const corrected = await CorrectIncidentFlagService(row.incidentId, f.data!.flag.reviewFlagId, { expectedUpdatedAt: f.data!.flag.updatedAt.toISOString(), reviewNotes: notes }, fire);
    expect(corrected.code).toBe(200); expect(await assessment(row.incidentId)).toBe(false);
    expect((await reports(medical, { reportView: 'false-reports', reportedBy: owner.sub })).body.data.pagination.total).toBe(0);
    expect((await reports(medical, { reportView: 'operational', responseService: 'MEDICAL', serviceStatuses: 'RESPONDING', reportedBy: owner.sub })).body.data.pagination.total).toBe(1);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: row.incidentId } })).status).toBe('RESPONDING');
  });
  it('filters false records before newest-first pagination/count and admits no held B response', async () => {
    const owner = await actor(), fire = await actor('FIRE'), main = await actor('MAIN');
    const ids: string[] = [];
    for (let index = 0; index < 7; index++) {
      const row = await report(owner); ids.push(row.incidentId);
      await prisma.incident.update({ where: { incidentId: row.incidentId }, data: { reportedAt: new Date(Date.UTC(2026, 9, 25, 0, index)) } });
      expect((await decide(await flag(row.incidentId, fire), fire)).code).toBe(200);
    }
    const first = await reports(fire, { reportView: 'false-reports', responseService: 'FIRE', reportedBy: owner.sub, limit: 5 });
    const second = await reports(fire, { reportView: 'false-reports', responseService: 'FIRE', reportedBy: owner.sub, limit: 5, page: 2 });
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(first.body.data.pagination).toMatchObject({ total: 7, pages: 2, limit: 5 });
    expect(first.body.data.incidents.map((item: { incidentId: string }) => item.incidentId)).toEqual(ids.slice().reverse().slice(0, 5));
    expect(second.body.data.incidents.map((item: { incidentId: string }) => item.incidentId)).toEqual(ids.slice().reverse().slice(5));
    expect((await reports(main, { reportView: 'all', reportedBy: owner.sub })).body.data.pagination.total).toBe(7);
    const childOwner = await actor(), parent = await report(await actor()), child = await report(childOwner);
    const review = await prisma.incidentNearbyReview.create({ data: { incidentId: child.incidentId, parentIncidentId: parent.incidentId, service: 'FIRE', status: 'ACKNOWLEDGED', version: 2, reviewedBy: fire.sub, reviewedAt: new Date() } });
    const pending = await FlagNearbyReview(review.reviewId, 2, notes, fire); expect(pending.code).toBe(200);
    const confirmed = await decide(pending.data!.flag, fire); expect(confirmed.code).toBe(200);
    expect((await reports(fire, { reportView: 'false-reports', reportedBy: childOwner.sub })).body.data.pagination.total).toBe(1);
    expect((await ListNearbyReviews(fire, { page: 1, incidentId: child.incidentId })).data?.items).toEqual([]);
    expect((await StartNearbyResponse(review.reviewId, 2, fire)).code).toBe(409);
    expect(await prisma.incidentNearbyResponseStart.count({ where: { reviewId: review.reviewId } })).toBe(0);
    expect((await CorrectIncidentFlagService(child.incidentId, confirmed.data!.flag.reviewFlagId, { expectedUpdatedAt: confirmed.data!.flag.updatedAt.toISOString(), reviewNotes: notes }, fire)).code).toBe(200);
    expect((await reports(fire, { reportView: 'operational', responseService: 'FIRE', serviceStatuses: 'RESPONDING', reportedBy: childOwner.sub })).body.data.pagination.total).toBe(0);
    expect((await ListNearbyReviews(fire, { page: 1, incidentId: child.incidentId })).data?.items[0]).toMatchObject({ status: 'ACKNOWLEDGED', responseStarted: false });
  });
  it('requires full consensus; genuine dismissal vetoes, preserves audit and prevents early cancellation', async () => {
    const owner = await actor(), main = await actor('MAIN'), fire = await actor('FIRE'), medical = await actor('MEDICAL');
    const row = await report(owner, ['FIRE','MEDICAL']), f = await flag(row.incidentId, fire), m = await flag(row.incidentId, medical);
    const first = await decide(f, fire); expect(first.code).toBe(200); expect(await count(owner, main)).toBe(0); expect(await assessment(row.incidentId)).toBe(false);
    expect((await CancelFalseIncidentService(row.incidentId, version(row, first.data!.flag), fire)).code).toBe(409);
    expect((await decide(m, medical, 'DISMISSED')).code).toBe(200); expect(await assessment(row.incidentId)).toBe(false);
    const reflag = await flag(row.incidentId, medical); expect((await decide(reflag, medical)).code).toBe(200);
    expect(await assessment(row.incidentId)).toBe(true); expect(await count(owner, main)).toBe(1);
    const correction = await CorrectIncidentFlagService(row.incidentId, first.data!.flag.reviewFlagId, { reviewNotes: notes, expectedUpdatedAt: first.data!.flag.updatedAt.toISOString() }, fire);
    expect(correction.code).toBe(200); expect(await assessment(row.incidentId)).toBe(false); expect(await count(owner, main)).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: row.incidentId, action: 'INCIDENT_FLAG_CORRECTED' } });
    expect(audit.metadata).toMatchObject({ previousReviewAuthority: 'DEPARTMENT', previousStatus: 'CONFIRMED', reviewAuthority: 'DEPARTMENT' });
  });
  it('serializes concurrent service decisions into one strike and one successful optimistic retry', async () => {
    const owner = await actor(), main = await actor('MAIN'), fire = await actor('FIRE'), medical = await actor('MEDICAL');
    const row = await report(owner, ['FIRE','MEDICAL']), f = await flag(row.incidentId, fire), m = await flag(row.incidentId, medical);
    expect((await Promise.all([decide(f, fire), decide(m, medical)])).map(r => r.code)).toEqual([200,200]);
    expect(await count(owner, main)).toBe(1);
    expect((await decide(f, fire)).code).toBe(409);
    const another = await report(owner), pending = await flag(another.incidentId, fire);
    expect((await Promise.all([decide(pending, fire), decide(pending, fire)])).map(r => r.code).sort()).toEqual([200,409]);
    expect(await count(owner, main)).toBe(2);
  });
  it('enforces current role/session, required notes and exact flag/report identity', async () => {
    const owner = await actor(), fire = await actor('FIRE'), row = await report(owner), f = await flag(row.incidentId, fire), other = await report(owner);
    expect((await ReviewIncidentFlagService(row.incidentId, f.reviewFlagId, { status: 'CONFIRMED', reviewNotes: 'short', expectedUpdatedAt: f.updatedAt.toISOString() }, fire)).code).toBe(400);
    expect((await ReviewIncidentFlagService(other.incidentId, f.reviewFlagId, { status: 'CONFIRMED', reviewNotes: notes, expectedUpdatedAt: f.updatedAt.toISOString() }, fire)).code).toBe(409);
    await prisma.user.update({ where: { id: fire.sub }, data: { department: 'MEDICAL' } }); expect((await decide(f, fire)).code).toBe(403);
    await prisma.user.update({ where: { id: fire.sub }, data: { department: 'FIRE' } });
    await prisma.token.update({ where: { id: fire.sessionId }, data: { revokedAt: new Date() } }); expect((await decide(f, fire)).code).toBe(403);
    expect((await ListIncidentReviewFlagsService(1, fire)).code).toBe(403);
    expect((await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { reviewFlagId: f.reviewFlagId } })).status).toBe('PENDING');
  });
  it('keeps B pending when flagged/reviewed and never counts intake rejection alone', async () => {
    const owner = await actor(), main = await actor('MAIN'), fire = await actor('FIRE'), parent = await report(await actor());
    const row = await report(owner), review = await prisma.incidentNearbyReview.create({ data: { incidentId: row.incidentId, parentIncidentId: parent.incidentId, service: 'FIRE' } });
    const flagged = await FlagNearbyReview(review.reviewId, 1, notes, fire); expect(flagged.code).toBe(200);
    expect((await decide(flagged.data!.flag, fire)).code).toBe(200);
    expect((await prisma.incidentNearbyReview.findUniqueOrThrow({ where: { reviewId: review.reviewId } })).status).toBe('PENDING');
    expect(await prisma.incidentNearbyResponseStart.count({ where: { reviewId: review.reviewId } })).toBe(0);
    const innocent = await report(owner), intake = await prisma.incidentNearbyReview.create({ data: { incidentId: innocent.incidentId, parentIncidentId: parent.incidentId, service: 'FIRE' } });
    expect((await DecideNearbyReview(intake.reviewId, { status: 'REJECTED', version: 1, reason: notes }, fire)).code).toBe(200);
    expect(await count(owner, main)).toBe(1);
  });
  it('retains legacy MAIN provenance without backfill; a new genuine assessment can veto it', async () => {
    const owner = await actor(), main = await actor('MAIN'), fire = await actor('FIRE'), row = await report(owner);
    await prisma.incidentReviewFlag.create({ data: { incidentId: row.incidentId, department: 'MAIN', flaggedBy: main.sub, status: 'CONFIRMED', reason: notes } });
    expect(await assessment(row.incidentId)).toBe(true); expect(await count(owner, main)).toBe(0);
    expect((await decide(await flag(row.incidentId, fire), fire, 'DISMISSED')).code).toBe(200);
    expect(await assessment(row.incidentId)).toBe(false); expect(await count(owner, main)).toBe(0);
  });
  it('deactivates at three distinct reports, revokes HTTP access, corrects without auto-restoration and preserves reset cycles', async () => {
    const owner = await actor(), main = await actor('MAIN'), fire = await actor('FIRE');
    const saved: IncidentReviewFlag[] = [];
    for (let i=0; i<3; i++) { const row = await report(owner); const result = await decide(await flag(row.incidentId, fire), fire); expect(result.code).toBe(200); saved.push(result.data!.flag); }
    expect(await count(owner, main)).toBe(3);
    const denied = await request(app).get('/api/incidents/v1/').set('Cookie', `accessToken=${signAccessToken(owner.sub, 'USER', '15m', owner.sessionId!)}`); expect(denied.status).toBe(403);
    const f = saved[0]; expect((await CorrectIncidentFlagService(f.incidentId, f.reviewFlagId, { reviewNotes: notes, expectedUpdatedAt: f.updatedAt.toISOString() }, fire)).code).toBe(200);
    expect(await count(owner, main)).toBe(2); expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.sub } })).status).toBe('INACTIVE');
    expect((await UpdateUserStatusService(owner.sub, 'ACTIVE', fire.sub)).code).toBe(403);
    expect((await UpdateUserStatusService(owner.sub, 'ACTIVE', main.sub)).code).toBe(200); expect(await count(owner, main)).toBe(0);
    expect((await decide(await flag(f.incidentId, fire), fire)).code).toBe(200); expect(await count(owner, main)).toBe(0);
  });
  it('cancels only complete consensus with versions, retaining decisions and evidence history', async () => {
    const owner = await actor(), fire = await actor('FIRE'), row = await report(owner), saved = await decide(await flag(row.incidentId, fire), fire);
    expect((await CancelFalseIncidentService(row.incidentId, { ...version(row, saved.data!.flag), expectedIncidentUpdatedAt: new Date(0).toISOString() }, fire)).code).toBe(409);
    expect((await CancelFalseIncidentService(row.incidentId, version(row, saved.data!.flag), fire)).code).toBe(200);
    const retained = await prisma.incident.findUniqueOrThrow({ where: { incidentId: row.incidentId }, include: { reviewFlags: true, serviceResponses: true } });
    expect(retained.status).toBe('CANCELLED'); expect(retained.reviewFlags).toHaveLength(1); expect(retained.serviceResponses[0].status).toBe('CANCELLED');
    const first = await ListIncidentReviewFlagsService(1, fire);
    const retainedIds = first.data!.flags.map(r => r.reviewFlagId);
    for (let page = 2; page <= first.data!.pagination.pages; page++) {
      const next = await ListIncidentReviewFlagsService(page, fire); expect(next.code).toBe(200);
      retainedIds.push(...next.data!.flags.map(r => r.reviewFlagId));
    }
    expect(retainedIds).toContain(saved.data!.flag.reviewFlagId);
  });
});
async function flagDenied(id: string, by: JwtPayload) { return (await FlagIncidentService(id, notes, by)).code; }
