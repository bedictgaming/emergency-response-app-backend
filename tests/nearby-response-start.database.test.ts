// Real PostgreSQL, HTTP/RBAC and concurrency; never an application database.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('@/lib/cloudinary', () => ({ verifyUploadedAsset: async (publicId: string, owner: string) => {
  if (!publicId.startsWith(`emergency-incidents/${owner}/`)) throw Error('Synthetic owner mismatch');
  return { publicId, url: 'https://evidence.invalid/start.jpg', format: 'jpg', bytes: 100, width: 10, height: 10, phash: publicId };
} }));
import request from 'supertest';
import app from '@/app';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { signAccessToken, type JwtPayload } from '@/lib/jwt';
import type { Department, ResponseService } from '@/generated/prisma';
import { CreateIncidentService } from '@/services/incident/create-incident-service';
import { DecideNearbyReview, StartNearbyResponse } from '@/services/incident/nearby-review-service';
import { UpdateServiceResponseService } from '@/services/incident/update-service-response-service';
import { CreateTaskService } from '@/services/task/create-task-service';
import { subscribeEmergencyEvents, type EmergencyEvent } from '@/lib/events';
const enabled = process.env.RUN_NATIVE_NEARBY_RESPONSE_START === '1';
const users: string[] = [], incidents: string[] = [], locations: string[] = [];
let typeId: string, barangayId: string, confirmed = false;
async function actor(department: Department | null = null, role: 'ADMIN' | 'USER' | 'DISPATCHER' = department ? 'ADMIN' : 'USER') {
  const id = randomUUID(); users.push(id);
  await prisma.user.create({ data: { id, name: 'Synthetic response start', role, department, isMainAdmin: department === 'MAIN', emailVerified: new Date() } });
  const session = await prisma.token.create({ data: { userId: id, token: randomUUID(), type: 'REFRESH', expiresAt: new Date(Date.now() + 3600000) } });
  const jwt: JwtPayload = { sub: id, sessionId: session.id, type: 'access', role, department, isMainAdmin: department === 'MAIN' };
  return { ...jwt, cookie: `accessToken=${signAccessToken(id, role, '15m', session.id)}` };
}
type Actor = Awaited<ReturnType<typeof actor>>;
function http(user: Actor, method: 'get' | 'post', suffix: string, body?: object) {
  const result = request(app)[method](`/api/incidents/v1/${suffix}`).set('Cookie', user.cookie).set('Origin', ENV.FRONTEND_URL);
  return body ? result.send(body) : result;
}
async function report(services: ResponseService[], latitude = 10.251) {
  const owner = await actor();
  const result = await CreateIncidentService({ submissionId: randomUUID(), title: 'Synthetic start; no emergency', typeId, barangayId,
    latitude, longitude: 123.949, requestedServices: services, proofAttachment: { publicId: `emergency-incidents/${owner.sub}/${randomUUID()}`, fileName: 'fixture.jpg' } }, owner.sub);
  expect(result.code).toBe(201);
  const incident = result.data!.incident; incidents.push(incident.incidentId); locations.push(incident.locationId);
  return { incident, owner };
}
const review = (incidentId: string, service: ResponseService) => prisma.incidentNearbyReview.findUniqueOrThrow({ where: { incidentId_service: { incidentId, service } } });
const responseIds = async (admin: Actor, service: ResponseService) => (await http(admin, 'get', `?responseService=${service}&includeTotal=false`)).body.data.incidents.map((row: { incidentId: string }) => row.incidentId);
const responsePage = async (admin: Actor, service?: ResponseService) => {
  const result = await http(admin, 'get', `?${service ? `responseService=${service}&serviceStatuses=RESPONDING` : 'statuses=RESPONDING'}`);
  expect(result.status).toBe(200);
  return result.body.data;
};
async function acknowledge(admin: Actor, incidentId: string, service: ResponseService) {
  const attention = await http(admin, 'get', `attention?responseService=${service}`);
  expect(attention.status).toBe(200);
  const item = attention.body.data.items.find((row: { incidentId: string }) => row.incidentId === incidentId);
  expect(item).toBeDefined();
  const result = await http(admin, 'post', `${incidentId}/attention/acknowledge`, { version: item.version, responseService: service });
  expect(result.status).toBe(200);
}
describe.runIf(enabled)('native quiet nearby review and explicit response start', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DISPOSABLE_DATABASE_URL || '');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/alert_disposable'
      || process.env.DATABASE_URL !== process.env.DISPOSABLE_DATABASE_URL || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
      || process.env.NEARBY_REVIEW_ENABLED !== 'true' || process.env.NEARBY_RESPONSE_START_ENABLED !== 'true'
      || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED
      || ENV.CLOUDINARY.API_SECRET || ENV.WEB_PUSH_PRIVATE_KEY || ENV.SMTP.PASS) throw Error('PROVIDER_FREE_NATIVE_START_TARGET_REQUIRED');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`)[0].name).toBe('alert_disposable');
    confirmed = true;
    for (const name of ['Alegria', 'Bangbang', 'Buagsong', 'Catarman', 'Cogon', 'Dapitan', 'Day-as', 'Gabi', 'Gilutongan', 'Ibabao', 'Pilipog', 'Poblacion', 'San Miguel']) {
      const barangay = await prisma.barangay.upsert({ where: { name }, create: { name }, update: {} });
      if (name === 'Poblacion') barangayId = barangay.barangayId;
    }
    typeId = (await prisma.incidentType.create({ data: { typeName: `Synthetic start ${randomUUID()}` } })).typeId;
  });
  afterAll(async () => {
    if (confirmed) {
      await prisma.incidentNearbyReview.deleteMany({ where: { incidentId: { in: incidents } } });
      await prisma.reportRequestContext.deleteMany({ where: { auditLog: { actorId: { in: users } } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
      await prisma.notificationOutbox.deleteMany({ where: { OR: incidents.map(id => ({ payload: { path: ['data', 'incidentId'], equals: id } })) } });
      await prisma.attachment.deleteMany({ where: { incidentId: { in: incidents } } });
      await prisma.task.deleteMany({ where: { incidentId: { in: incidents } } });
      await prisma.incident.deleteMany({ where: { incidentId: { in: incidents } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.location.deleteMany({ where: { locationId: { in: locations } } });
      if (typeId) await prisma.incidentType.delete({ where: { typeId } });
    }
    await prisma.$disconnect();
  });
  it.each(['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const)('%s B stays quiet and held after ACK; explicit start alone admits it', async service => {
    const admin = await actor(service === 'HAZARD' ? 'DRRMO' : service), main = await actor('MAIN'), other = await actor(service === 'FIRE' ? 'MEDICAL' : 'FIRE');
    const a = await report([service]), b = await report([service], 10.25102), id = b.incident.incidentId;
    const held = await review(id, service);
    expect(held.parentIncidentId).toBe(a.incident.incidentId);
    for (const user of [admin, main]) {
      const queue = (await http(user, 'get', `attention${user === admin ? `?responseService=${service}` : ''}`)).body.data.items;
      expect(queue.map((row: { incidentId: string }) => row.incidentId)).not.toContain(id);
      expect(queue.map((row: { incidentId: string }) => row.incidentId)).toContain(a.incident.incidentId);
    }
    expect(await responseIds(admin, service)).not.toContain(a.incident.incidentId);
    expect((await responsePage(main)).incidents.map((row: { incidentId: string }) => row.incidentId)).not.toContain(a.incident.incidentId);
    expect((await responsePage(admin, service)).summary.responding).toBe(0);
    // Main cannot self-admit A, and another department cannot hand it off.
    expect((await http(main, 'post', `${a.incident.incidentId}/attention/acknowledge`, { version: 1, responseService: service })).status).toBe(403);
    expect((await http(other, 'post', `${a.incident.incidentId}/attention/acknowledge`, { version: 1, responseService: service })).status).toBe(403);
    expect(await responseIds(admin, service)).not.toContain(a.incident.incidentId);
    const events: EmergencyEvent[] = [], unsubscribe = subscribeEmergencyEvents(event => events.push(event));
    try { await acknowledge(admin, a.incident.incidentId, service); } finally { unsubscribe(); }
    expect(events).toEqual([expect.objectContaining({ type: 'incident.updated', entityId: a.incident.incidentId })]);
    expect(await responseIds(admin, service)).toContain(a.incident.incidentId);
    expect((await responsePage(main)).incidents.map((row: { incidentId: string }) => row.incidentId)).toContain(a.incident.incidentId);
    expect((await responsePage(admin, service)).summary.responding).toBe(1);
    expect((await responsePage(admin, service)).pagination.total).toBe(1);
    expect((await http(admin, 'post', `${a.incident.incidentId}/attention/acknowledge`, { version: 1, responseService: service })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { entityId: a.incident.incidentId, action: 'INCIDENT_ATTENTION_ACKNOWLEDGED' } })).toBe(1);
    expect(await prisma.incidentNearbyResponseStart.count({ where: { reviewId: held.reviewId } })).toBe(0);
    const colleague = await actor(service === 'HAZARD' ? 'DRRMO' : service);
    expect(await responseIds(colleague, service)).toContain(a.incident.incidentId);
    expect(await responseIds(admin, service)).not.toContain(id);
    const flagPath = `nearby-reviews/${held.reviewId}/flag`, reason = 'Synthetic suspected false report; needs Main Admin review.';
    expect((await http(main, 'post', flagPath, { version: 1, reason })).status).toBe(403);
    expect((await http(other, 'post', flagPath, { version: 1, reason })).status).not.toBe(200);
    expect((await http(admin, 'post', flagPath, { version: 1, reason, status: 'REJECTED' })).status).toBe(400);
    expect((await http(admin, 'post', `${id}/review-flags`, { reason })).status).toBe(409);
    expect((await http(admin, 'post', flagPath, { version: 1, reason })).status).toBe(200);
    expect((await http(admin, 'post', flagPath, { version: 1, reason: 'Synthetic retry must not overwrite the first reason.' })).status).toBe(200);
    expect((await review(id, service))).toMatchObject({ status: 'PENDING', version: 1 });
    expect(await prisma.incidentReviewFlag.findMany({ where: { incidentId: id } })).toMatchObject([{ status: 'PENDING', reason }]);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: 'INCIDENT_FLAGGED' } })).toBe(1);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: id } })).status).toBe('OPEN');
    expect((await StartNearbyResponse(held.reviewId, 1, admin)).code).toBe(409);
    expect((await StartNearbyResponse(held.reviewId, 1, main)).code).toBe(403);
    expect((await StartNearbyResponse(held.reviewId, 1, other)).code).not.toBe(200);
    expect((await http(admin, 'post', `nearby-reviews/${held.reviewId}/decision`, { status: 'ACKNOWLEDGED', version: 1 })).status).toBe(200);
    const acknowledged = await review(id, service);
    expect(acknowledged.version).toBe(2);
    expect((await http(admin, 'post', flagPath, { version: 1, reason })).status).toBe(409);
    expect((await http(admin, 'post', flagPath, { version: 2, reason })).status).toBe(200);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: id } })).status).toBe('OPEN');
    expect(await responseIds(admin, service)).not.toContain(id);
    expect((await responsePage(admin, service)).summary.responding).toBe(1);
    expect((await UpdateServiceResponseService(id, service, 'RESOLVED', admin)).code).toBe(409);
    expect((await CreateTaskService(id, { taskName: 'Synthetic forbidden bypass', priority: 'MEDIUM' }, admin.sub)).code).toBe(409);
    const own = (await http(b.owner, 'get', id)).body.data.incident;
    expect(own.nearbyIntake).toEqual([{ service, status: 'ACKNOWLEDGED', responseStarted: false }]);
    expect(JSON.stringify(own)).not.toContain(a.incident.incidentId);
    const detection = (await http(admin, 'post', 'nearby-detection', { kind: 'department', incidentId: a.incident.incidentId })).body.data;
    expect(detection.reviewIncidentIds).toContain(id); expect(detection.waitingIncidentIds).toContain(id);
    const list = (await http(admin, 'get', `nearby-reviews?incidentId=${id}`)).body.data;
    expect(list.requiresResponseStart).toBe(true); expect(list.items[0].responseStarted).toBe(false);
    expect((await http(admin, 'post', `nearby-reviews/${held.reviewId}/start-response`, { version: 1 })).status).toBe(409);
    expect((await http(admin, 'post', `nearby-reviews/${held.reviewId}/start-response`, { version: 2, status: 'RESPONDING' })).status).toBe(400);
    expect((await http(admin, 'post', `nearby-reviews/${held.reviewId}/start-response`, { version: 2 })).status).toBe(200);
    expect((await StartNearbyResponse(held.reviewId, 2, admin)).code).toBe(200);
    const started = await review(id, service);
    expect(started).toMatchObject({ status: 'ACKNOWLEDGED', version: 3, reviewedBy: acknowledged.reviewedBy, reviewedAt: acknowledged.reviewedAt, reason: acknowledged.reason });
    expect((await http(admin, 'post', flagPath, { version: 3, reason })).status).toBe(409);
    expect(await responseIds(admin, service)).toContain(id);
    expect((await responsePage(admin, service)).summary.responding).toBe(2);
    expect((await responsePage(admin, service)).pagination.total).toBe(2);
    expect(await prisma.incidentNearbyResponseStart.count({ where: { reviewId: held.reviewId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: 'NEARBY_RESPONSE_STARTED' } })).toBe(1);
    expect((await http(admin, 'get', `attention?responseService=${service}`)).body.data.items.map((row: { incidentId: string }) => row.incidentId)).not.toContain(id);
    expect((await http(main, 'get', 'attention')).body.data.items.map((row: { incidentId: string }) => row.incidentId)).not.toContain(id);
  });
  it('serializes competing starts and rechecks transfer, revoked session and inactive account', async () => {
    const a = await actor('POLICE'), b = await actor('POLICE'), target = await report(['POLICE']), held = await review(target.incident.incidentId, 'POLICE');
    expect((await DecideNearbyReview(held.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, a)).code).toBe(200);
    expect((await Promise.all([StartNearbyResponse(held.reviewId, 2, a), StartNearbyResponse(held.reviewId, 2, b)])).map(result => result.code).sort()).toEqual([200, 409]);
    for (const change of ['transfer', 'revoke', 'inactive', 'dispatcher'] as const) {
      const admin = await actor('FIRE'), target = await report(['FIRE']), pending = await review(target.incident.incidentId, 'FIRE');
      expect((await DecideNearbyReview(pending.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, admin)).code).toBe(200);
      if (change === 'transfer') await prisma.user.update({ where: { id: admin.sub }, data: { department: 'MEDICAL' } });
      if (change === 'inactive') await prisma.user.update({ where: { id: admin.sub }, data: { status: 'INACTIVE' } });
      if (change === 'dispatcher') await prisma.user.update({ where: { id: admin.sub }, data: { role: 'DISPATCHER' } });
      if (change === 'revoke') await prisma.token.update({ where: { id: admin.sessionId }, data: { revokedAt: new Date() } });
      expect((await StartNearbyResponse(pending.reviewId, 2, admin)).code).toBe(403);
      expect((await http(admin, 'post', `nearby-reviews/${pending.reviewId}/flag`, { version: 2, reason: 'Synthetic unavailable authority must not flag a report.' })).status).toBe(change === 'revoke' ? 401 : 403);
      expect(await prisma.incidentReviewFlag.count({ where: { incidentId: target.incident.incidentId } })).toBe(0);
      expect(await prisma.incidentNearbyResponseStart.count({ where: { reviewId: pending.reviewId } })).toBe(0);
    }
  });
  it('keeps waiting services independent and does not resolve unfinished intake', async () => {
    const fire = await actor('FIRE'), medical = await actor('MEDICAL'), target = await report(['FIRE', 'MEDICAL']);
    const f = await review(target.incident.incidentId, 'FIRE'), m = await review(target.incident.incidentId, 'MEDICAL');
    await DecideNearbyReview(f.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, fire);
    await DecideNearbyReview(m.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, medical);
    await StartNearbyResponse(f.reviewId, 2, fire);
    expect((await UpdateServiceResponseService(target.incident.incidentId, 'FIRE', 'RESOLVED', fire)).code).toBe(200);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: target.incident.incidentId } })).status).toBe('OPEN');
    expect(await responseIds(medical, 'MEDICAL')).not.toContain(target.incident.incidentId);
    expect((await StartNearbyResponse(m.reviewId, 2, medical)).code).toBe(200);
    expect((await UpdateServiceResponseService(target.incident.incidentId, 'MEDICAL', 'RESOLVED', medical)).code).toBe(200);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: target.incident.incidentId } })).status).toBe('RESOLVED');
  });
  it('retains rejected reports and cannot start them', async () => {
    const admin = await actor('FIRE'), target = await report(['FIRE']), held = await review(target.incident.incidentId, 'FIRE');
    expect((await DecideNearbyReview(held.reviewId, { status: 'REJECTED', version: 1, reason: 'Synthetic evidence review confirmed a false report.' }, admin)).code).toBe(200);
    expect((await StartNearbyResponse(held.reviewId, 2, admin)).code).toBe(409);
    expect(await prisma.attachment.count({ where: { incidentId: target.incident.incidentId } })).toBe(1);
  });
  it('keeps a normal service lane alerting while another service waits for review', async () => {
    const fire = await actor('FIRE'), medical = await actor('MEDICAL'), main = await actor('MAIN');
    await report(['FIRE'], 10.255);
    const target = await report(['FIRE', 'MEDICAL'], 10.25502), id = target.incident.incidentId;
    expect(await prisma.incidentNearbyReview.count({ where: { incidentId: id } })).toBe(1);
    expect(await responseIds(fire, 'FIRE')).not.toContain(id);
    expect(await responseIds(medical, 'MEDICAL')).not.toContain(id);
    for (const admin of [medical, main]) {
      const queue = (await http(admin, 'get', admin === main ? 'attention' : 'attention?responseService=MEDICAL')).body.data.items;
      expect(queue.map((row: { incidentId: string }) => row.incidentId)).toContain(id);
      expect(queue.find((row: { incidentId: string }) => row.incidentId === id).pendingNearbyReview).not.toBe(true);
    }
    await acknowledge(medical, id, 'MEDICAL');
    expect(await responseIds(medical, 'MEDICAL')).toContain(id);
    expect(await responseIds(fire, 'FIRE')).not.toContain(id);
    expect((await responsePage(main)).incidents.map((row: { incidentId: string }) => row.incidentId)).toContain(id);
    const counters = await http(main, 'get', '?reportedBy=' + target.owner.sub + '&includeServiceSummary=true');
    expect(counters.status).toBe(200);
    expect(counters.body.data.summary.services).toMatchObject({ fire: 0, medical: 1 });
  });
  it('keeps original multi-service acknowledgements independent, preserves admission across operator transfer and retains history', async () => {
    const fire = await actor('FIRE'), medical = await actor('MEDICAL'), main = await actor('MAIN');
    const target = await report(['FIRE', 'MEDICAL'], 10.253), id = target.incident.incidentId;
    expect(await prisma.incidentNearbyReview.count({ where: { incidentId: id } })).toBe(0);
    expect(await responseIds(fire, 'FIRE')).not.toContain(id);
    expect(await responseIds(medical, 'MEDICAL')).not.toContain(id);
    const ownBefore = await http(target.owner, 'get', '?includeServiceSummary=true');
    expect(ownBefore.status).toBe(200);
    expect(ownBefore.body.data.incidents.map((row: { incidentId: string }) => row.incidentId)).toContain(id);
    expect(ownBefore.body.data.summary.services).toMatchObject({ fire: 1, medical: 1 });
    await acknowledge(fire, id, 'FIRE');
    expect(await responseIds(fire, 'FIRE')).toContain(id);
    expect(await responseIds(medical, 'MEDICAL')).not.toContain(id);
    expect((await responsePage(main, 'MEDICAL')).incidents.map((row: { incidentId: string }) => row.incidentId)).not.toContain(id);
    const colleague = await actor('FIRE');
    await prisma.user.update({ where: { id: fire.sub }, data: { department: 'POLICE', status: 'INACTIVE' } });
    expect(await responseIds(colleague, 'FIRE')).toContain(id);
    await acknowledge(medical, id, 'MEDICAL');
    expect(await responseIds(medical, 'MEDICAL')).toContain(id);
    expect((await UpdateServiceResponseService(id, 'FIRE', 'RESOLVED', colleague)).code).toBe(200);
    expect((await UpdateServiceResponseService(id, 'MEDICAL', 'RESOLVED', medical)).code).toBe(200);
    const history = await http(colleague, 'get', '?responseService=FIRE&serviceStatuses=RESOLVED');
    expect(history.status).toBe(200);
    expect(history.body.data.incidents.map((row: { incidentId: string }) => row.incidentId)).toContain(id);
    const mine = await http(target.owner, 'get', id);
    expect(mine.status).toBe(200);
    expect(mine.body.data.incident.status).toBe('RESOLVED');
  });
  it('resolving A does not silently acknowledge or start its waiting B', async () => {
    const admin = await actor('POLICE');
    const a = await report(['POLICE'], 10.257), b = await report(['POLICE'], 10.25702);
    const held = await review(b.incident.incidentId, 'POLICE');
    expect(held.parentIncidentId).toBe(a.incident.incidentId);
    await acknowledge(admin, a.incident.incidentId, 'POLICE');
    expect((await UpdateServiceResponseService(a.incident.incidentId, 'POLICE', 'RESOLVED', admin)).code).toBe(200);
    expect(await review(b.incident.incidentId, 'POLICE')).toMatchObject({ status: 'PENDING', version: 1 });
    expect(await responseIds(admin, 'POLICE')).not.toContain(b.incident.incidentId);
    expect((await DecideNearbyReview(held.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, admin)).code).toBe(200);
    expect(await responseIds(admin, 'POLICE')).not.toContain(b.incident.incidentId);
    expect((await StartNearbyResponse(held.reviewId, 2, admin)).code).toBe(200);
    expect(await responseIds(admin, 'POLICE')).toContain(b.incident.incidentId);
  });
  it('atomically rolls back start receipt, incident status and version if the audit cannot commit', async () => {
    const admin = await actor('FIRE'), target = await report(['FIRE']), held = await review(target.incident.incidentId, 'FIRE');
    await DecideNearbyReview(held.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, admin);
    // Guarded disposable target only; this function fails just this synthetic
    // audit and is removed in finally even if the assertion fails.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION synthetic_start_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id = '${target.incident.incidentId}' AND NEW.action = 'NEARBY_RESPONSE_STARTED' THEN RAISE EXCEPTION 'SYNTHETIC_START_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`);
    try {
      await prisma.$executeRawUnsafe('CREATE TRIGGER synthetic_start_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION synthetic_start_audit_failure()');
      expect((await StartNearbyResponse(held.reviewId, 2, admin)).code).not.toBe(200);
      expect(await prisma.incidentNearbyResponseStart.count({ where: { reviewId: held.reviewId } })).toBe(0);
      expect((await review(target.incident.incidentId, 'FIRE')).version).toBe(2);
      expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: target.incident.incidentId } })).status).toBe('OPEN');
    } finally { await prisma.$executeRawUnsafe('DROP FUNCTION synthetic_start_audit_failure() CASCADE'); }
  });
});
