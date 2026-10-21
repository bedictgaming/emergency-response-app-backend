// Real transactions/HTTP on the guarded, provider-free native test database.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('@/lib/cloudinary', () => ({ verifyUploadedAsset: async (publicId: string, owner: string) => {
  if (!publicId.startsWith(`emergency-incidents/${owner}/`)) throw Error('Synthetic owner mismatch');
  return { publicId, url: 'https://evidence.invalid/intake.jpg', format: 'jpg', bytes: 100, width: 10, height: 10, phash: publicId };
} }));
import request from 'supertest';
import app from '@/app';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { signAccessToken, type JwtPayload } from '@/lib/jwt';
import type { Department, ResponseService } from '@/generated/prisma';
import { CreateIncidentService } from '@/services/incident/create-incident-service';
import { DecideNearbyReview } from '@/services/incident/nearby-review-service';
import { UpdateServiceResponseService } from '@/services/incident/update-service-response-service';
import { CreateTaskService } from '@/services/task/create-task-service';
import { DeleteIncidentService } from '@/services/incident/delete-incident-service';
const enabled = process.env.RUN_NATIVE_NEARBY_REVIEW === '1';
const users: string[] = [], incidents: string[] = [], locations: string[] = [], extraTypes: string[] = [];
let typeId: string, barangayId: string, confirmed = false;
async function actor(department: Department | null = null, role: 'ADMIN' | 'USER' | 'DISPATCHER' = department ? 'ADMIN' : 'USER') {
  const id = randomUUID(); users.push(id);
  await prisma.user.create({ data: { id, name: 'Synthetic nearby intake', role, department, isMainAdmin: department === 'MAIN', emailVerified: new Date() } });
  const token = await prisma.token.create({ data: { userId: id, token: randomUUID(), type: 'REFRESH', expiresAt: new Date(Date.now() + 3600000) } });
  const jwt: JwtPayload = { sub: id, sessionId: token.id, type: 'access', role, department, isMainAdmin: department === 'MAIN' };
  return { ...jwt, cookie: `accessToken=${signAccessToken(id, role, '15m', token.id)}` };
}
type Actor = Awaited<ReturnType<typeof actor>>;
function http(user: Actor, method: 'get' | 'post', path: string, body?: object) {
  const result = request(app)[method](`/api/incidents/v1/${path}`).set('Cookie', user.cookie).set('Origin', ENV.FRONTEND_URL);
  return body ? result.send(body) : result;
}
async function report(services: ResponseService[], latitude = 10.251, citizen?: Actor) {
  const owner = citizen ?? await actor();
  const result = await CreateIncidentService({ submissionId: randomUUID(), title: 'Synthetic intake report; no emergency', typeId, barangayId,
    latitude, longitude: 123.949, requestedServices: services, proofAttachment: { publicId: `emergency-incidents/${owner.sub}/${randomUUID()}`, fileName: 'fixture.jpg' } }, owner.sub);
  expect(result.code).toBe(201);
  const created = result.data!.incident; incidents.push(created.incidentId); locations.push(created.locationId);
  return { incident: created, owner };
}
async function pending(id: string, service: ResponseService) {
  return prisma.incidentNearbyReview.findUniqueOrThrow({ where: { incidentId_service: { incidentId: id, service } } });
}
describe.runIf(enabled)('native nearby department intake', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DISPOSABLE_DATABASE_URL || '');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/alert_disposable'
      || process.env.DATABASE_URL !== process.env.DISPOSABLE_DATABASE_URL || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
      || process.env.NEARBY_REVIEW_ENABLED !== 'true' || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED
      || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED || ENV.CLOUDINARY.API_SECRET || ENV.WEB_PUSH_PRIVATE_KEY || ENV.SMTP.PASS)
      throw Error('PROVIDER_FREE_NATIVE_INTAKE_TARGET_REQUIRED');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`)[0].name).toBe('alert_disposable');
    confirmed = true;
    for (const name of ['Alegria', 'Bangbang', 'Buagsong', 'Catarman', 'Cogon', 'Dapitan', 'Day-as', 'Gabi', 'Gilutongan', 'Ibabao', 'Pilipog', 'Poblacion', 'San Miguel']) {
      const barangay = await prisma.barangay.upsert({ where: { name }, create: { name }, update: {} });
      if (name === 'Poblacion') barangayId = barangay.barangayId;
    }
    typeId = (await prisma.incidentType.create({ data: { typeName: `Synthetic General intake ${randomUUID()}` } })).typeId;
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
      if (extraTypes.length) await prisma.incidentType.deleteMany({ where: { typeId: { in: extraTypes } } });
    }
    await prisma.$disconnect();
  });
  it.each(['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const)('holds later %s reports, retains evidence, and admits only after the assigned decision', async service => {
    const admin = await actor(service === 'HAZARD' ? 'DRRMO' : service), main = await actor('MAIN'), unrelated = await actor(service === 'FIRE' ? 'MEDICAL' : 'FIRE');
    const a = await report([service]), b = await report([service], 10.25102);
    const review = await pending(b.incident.incidentId, service);
    expect(review.parentIncidentId).toBe(a.incident.incidentId);
    expect(b.incident.status).toBe('OPEN');
    const list = await http(admin, 'get', `?responseService=${service}&includeTotal=false`);
    expect(list.status).toBe(200); expect(list.body.data.incidents.map((row: { incidentId: string }) => row.incidentId)).not.toContain(b.incident.incidentId);
    const own = await http(b.owner, 'get', b.incident.incidentId);
    expect(own.body.data.incident.nearbyIntake).toEqual([{ service, status: 'PENDING' }]);
    expect(JSON.stringify(own.body)).not.toContain(a.incident.incidentId);
    const queue = await http(admin, 'get', `attention?responseService=${service}`);
    expect(queue.body.data.items.find((row: { incidentId: string }) => row.incidentId === b.incident.incidentId).pendingNearbyReview).toBe(true);
    expect((await http(admin, 'post', `${b.incident.incidentId}/attention/acknowledge`, { version: 1, responseService: service })).status).toBe(409);
    expect((await DecideNearbyReview(review.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, main)).code).toBe(403);
    expect((await DecideNearbyReview(review.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, unrelated)).code).not.toBe(200);
    const detection = await http(admin, 'post', 'nearby-detection', { kind: 'department', incidentId: a.incident.incidentId });
    expect(detection.body.data.reviewIncidentIds).toEqual([b.incident.incidentId]);
    expect((await DecideNearbyReview(review.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, admin)).code).toBe(200);
    expect((await DecideNearbyReview(review.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, admin)).code).toBe(200);
    const admitted = await http(admin, 'get', `?responseService=${service}&includeTotal=false`);
    expect(admitted.body.data.incidents.map((row: { incidentId: string }) => row.incidentId)).toContain(b.incident.incidentId);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: b.incident.incidentId } })).status).toBe('RESPONDING');
    expect(await prisma.attachment.count({ where: { incidentId: b.incident.incidentId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: b.incident.incidentId, action: 'NEARBY_REPORT_ACKNOWLEDGED' } })).toBe(1);
    expect((await http(main, 'get', 'attention')).body.data.items.map((row: { incidentId: string }) => row.incidentId)).not.toContain(b.incident.incidentId);
  });
  it('rejects with a reason, retains the report/photo and exposes the department decision history', async () => {
    const admin = await actor('FIRE'), b = await report(['FIRE']); const review = await pending(b.incident.incidentId, 'FIRE');
    expect((await DecideNearbyReview(review.reviewId, { status: 'REJECTED', version: 1 }, admin)).code).toBe(400);
    expect((await UpdateServiceResponseService(b.incident.incidentId, 'FIRE', 'RESOLVED', admin)).code).toBe(409);
    expect((await CreateTaskService(b.incident.incidentId, { taskName: 'Synthetic forbidden task', priority: 'MEDIUM' }, admin.sub)).code).toBe(409);
    expect((await DecideNearbyReview(review.reviewId, { status: 'REJECTED', version: 1, reason: 'Synthetic investigation confirmed this was a fake submission.' }, admin)).code).toBe(200);
    const retained = await prisma.incident.findUniqueOrThrow({ where: { incidentId: b.incident.incidentId }, include: { attachments: true } });
    expect(retained).toMatchObject({ status: 'CANCELLED', verificationStatus: 'REJECTED' }); expect(retained.attachments).toHaveLength(1);
    const main = await actor('MAIN');
    expect((await DeleteIncidentService(b.incident.incidentId, main, { confirmation: 'DELETE', reason: 'Synthetic attempt to remove retained review evidence.' })).code).toBe(409);
    expect(await prisma.attachment.count({ where: { incidentId: b.incident.incidentId } })).toBe(1);
    const history = await http(admin, 'get', 'nearby-reviews?status=REJECTED');
    expect(history.body.data.items.map((row: { reviewId: string }) => row.reviewId)).toContain(review.reviewId);
    expect((await http(admin, 'get', 'attention?responseService=FIRE')).body.data.items.map((row: { incidentId: string }) => row.incidentId)).not.toContain(b.incident.incidentId);
  });
  it('uses the real HTTP submission schema and ignores client-forged intake/status approval', async () => {
    const citizen = await actor();
    const fireType = await prisma.incidentType.create({ data: { typeName: `Fire synthetic HTTP ${randomUUID()}` } }); extraTypes.push(fireType.typeId);
    const response = await http(citizen, 'post', '', { submissionId: randomUUID(), title: 'Synthetic HTTP fire follow-up', category: 'fire',
      typeId: fireType.typeId, barangayId, latitude: 10.251, longitude: 123.949,
      proofAttachment: { publicId: `emergency-incidents/${citizen.sub}/${randomUUID()}`, fileName: 'synthetic-http.jpg' },
      intakeStatus: 'ACKNOWLEDGED', status: 'RESOLVED', verifiedBy: citizen.sub,
      ipAddress: '198.51.100.200', userAgent: 'Forged payload browser',
    }).set('User-Agent', 'Synthetic panel native test').set('X-Forwarded-For', '198.51.100.200');
    expect(response.status).toBe(201);
    const created = response.body.data.incident; incidents.push(created.incidentId); locations.push(created.locationId);
    expect(created.status).toBe('OPEN'); expect(created.nearbyIntake).toEqual([{ service: 'FIRE', status: 'PENDING' }]);
    const receipt = await prisma.auditLog.findFirstOrThrow({ where: { entityId: created.incidentId, action: 'INCIDENT_CREATED' } });
    expect(receipt.ipAddress).toBeNull(); expect(receipt.metadata).not.toHaveProperty('userAgent');
    const context = await prisma.reportRequestContext.findUniqueOrThrow({ where: { auditLogId: receipt.auditLogId } });
    expect(context.ipAddress).toBeTruthy(); expect(context.ipAddress).not.toBe('198.51.100.200');
    expect(context.userAgent).toBe('Synthetic panel native test');
    expect(context.expiresAt.getTime() - context.capturedAt.getTime()).toBe(30 * 24 * 60 * 60_000);
    expect((await pending(created.incidentId, 'FIRE')).status).toBe('PENDING');
    expect((await http(citizen, 'get', 'nearby-reviews')).status).toBe(403);
  });
  it('isolates decisions on shared reports and resolves admitted work despite another department rejection', async () => {
    const fire = await actor('FIRE'), medical = await actor('MEDICAL');
    const b = await report(['FIRE', 'MEDICAL']);
    const f = await pending(b.incident.incidentId, 'FIRE'), m = await pending(b.incident.incidentId, 'MEDICAL');
    expect((await DecideNearbyReview(f.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, fire)).code).toBe(200);
    expect((await pending(b.incident.incidentId, 'MEDICAL')).status).toBe('PENDING');
    expect((await http(medical, 'get', '?responseService=MEDICAL&includeTotal=false')).body.data.incidents.map((row: { incidentId: string }) => row.incidentId)).not.toContain(b.incident.incidentId);
    expect((await DecideNearbyReview(m.reviewId, { status: 'REJECTED', version: 1, reason: 'Synthetic medical department review found no medical emergency.' }, medical)).code).toBe(200);
    expect((await prisma.incidentServiceResponse.findUniqueOrThrow({ where: { incidentId_service: { incidentId: b.incident.incidentId, service: 'FIRE' } } })).status).toBe('RESPONDING');
    expect((await UpdateServiceResponseService(b.incident.incidentId, 'FIRE', 'RESOLVED', fire)).code).toBe(200);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: b.incident.incidentId } })).status).toBe('RESOLVED');
  });
  it('allows only one competing final decision and rejects stale decisions', async () => {
    const first = await actor('POLICE'), second = await actor('POLICE'), b = await report(['POLICE']); const review = await pending(b.incident.incidentId, 'POLICE');
    const decisions = await Promise.all([
      DecideNearbyReview(review.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, first),
      DecideNearbyReview(review.reviewId, { status: 'REJECTED', version: 1, reason: 'Synthetic competing rejection after review of the evidence.' }, second),
    ]);
    expect(decisions.map(row => row.code).sort()).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { entityId: b.incident.incidentId, action: { in: ['NEARBY_REPORT_ACKNOWLEDGED', 'NEARBY_REPORT_REJECTED'] } } })).toBe(1);
  });
  it('rechecks account and session authority before deciding', async () => {
    for (const change of ['transfer', 'revoke'] as const) {
      const admin = await actor('FIRE'), b = await report(['FIRE']); const review = await pending(b.incident.incidentId, 'FIRE');
      if (change === 'transfer') await prisma.user.update({ where: { id: admin.sub }, data: { department: 'MEDICAL' } });
      else await prisma.token.update({ where: { id: admin.sessionId }, data: { revokedAt: new Date() } });
      expect((await DecideNearbyReview(review.reviewId, { status: 'ACKNOWLEDGED', version: 1 }, admin)).code).toBe(403);
      expect((await pending(b.incident.incidentId, 'FIRE')).status).toBe('PENDING');
    }
  });
  it('serializes concurrent nearby submissions into one original and one pending follow-up', async () => {
    const pair = await Promise.all([report(['FIRE'], 10.255), report(['FIRE'], 10.25502)]);
    const ids = pair.map(item => item.incident.incidentId);
    const reviews = await prisma.incidentNearbyReview.findMany({ where: { incidentId: { in: ids } } });
    expect(reviews).toHaveLength(1);
    expect(ids).toContain(reviews[0].parentIncidentId);
    expect(reviews[0].incidentId).not.toBe(reviews[0].parentIncidentId);
    expect(pair.map(item => item.incident.status).sort()).toEqual(['OPEN', 'RESPONDING']);
  });
});
