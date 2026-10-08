import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '@/app';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { signAccessToken } from '@/lib/jwt';
import { notificationRelevant } from '@/lib/notification-relevance';
import type { Department } from '@/generated/prisma';

const run = process.env.RUN_ALERT_DATABASE_TESTS === '1';
const suite = describe.runIf(run);
const users: Array<{ id: string; department?: Department; cookie: string }> = [];
const ids: string[] = [];
let typeId: string, locationId: string;
function guard() {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.DATABASE_URL !== process.env.DISPOSABLE_DATABASE_URL || !['127.0.0.1','localhost'].includes(url.hostname)
    || process.env.CONFIRM_DISPOSABLE_DATABASE !== decodeURIComponent(url.pathname.slice(1)) || !/disposable|test/.test(url.pathname)
    || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED || ENV.API_GATEWAY_REQUIRED
    || ENV.WEB_PUSH_PRIVATE_KEY || ENV.CLOUDINARY.API_SECRET || ENV.SMTP.PASS) throw new Error('Refusing alert integration test outside a provider-free disposable loopback database');
}
const getQueue = (index: number, query = '') => request(app).get(`/api/incidents/v1/attention${query}`).set('Cookie', users[index].cookie);
const ack = (index: number, id: string, version: number) => request(app).post(`/api/incidents/v1/${id}/attention/acknowledge`).set('Cookie', users[index].cookie).set('Origin', ENV.FRONTEND_URL).send({ version });
suite('actual database attention/RBAC/workflow contracts', () => {
  beforeAll(async () => {
    guard();
    for (const department of ['MAIN','FIRE','MEDICAL','POLICE','DRRMO',undefined] as const) {
      const id = randomUUID(), session = randomUUID();
      await prisma.user.create({ data: { id, name: 'Synthetic alert gate', role: department ? 'ADMIN' : 'USER', department, isMainAdmin: department === 'MAIN', emailVerified: new Date() } });
      await prisma.token.create({ data: { id: session, userId: id, type: 'REFRESH', token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
      users.push({ id, department, cookie: `accessToken=${signAccessToken(id, department ? 'ADMIN' : 'USER', '15m', session)}` });
    }
    typeId = (await prisma.incidentType.create({ data: { typeName: `Synthetic multi alert ${randomUUID()}` } })).typeId;
    locationId = (await prisma.location.create({ data: { locationName: 'Synthetic location', address: 'Not an emergency' } })).locationId;
    for (let index = 0; index < 53; index++) {
      const incidentId = randomUUID(); ids.push(incidentId);
      await prisma.incident.create({ data: { incidentId, title: `Synthetic alert ${index}`, typeId, locationId, reportedBy: users[5].id,
        severityLevel: 'LOW', status: index === 52 ? 'RESOLVED' : 'RESPONDING', verificationStatus: 'VERIFIED', requestedServices: ['FIRE','MEDICAL'],
        reportedAt: new Date(Date.UTC(2026,8,1,0,index)), serviceResponses: { create: ['FIRE','MEDICAL'].map(service => ({ service: service as 'FIRE' | 'MEDICAL', status: index === 52 ? 'RESOLVED' : 'RESPONDING' })) } } });
    }
  }, 60000);
  afterAll(async () => {
    if (!run) return;
    await prisma.notificationOutbox.deleteMany({ where: { audienceIds: { hasSome: users.map(user => user.id) } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.incident.deleteMany({ where: { incidentId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    if (locationId) await prisma.location.delete({ where: { locationId } });
    if (typeId) await prisma.incidentType.delete({ where: { typeId } });
    await prisma.$disconnect();
  }, 60000);
  it('returns all selected-service scopes, no unrelated/citizen access, no resolved reports, and an explicit >50 backlog', async () => {
    for (const index of [0,1,2]) {
      const response = await getQueue(index); expect(response.status).toBe(200);
      expect(response.body.data.items).toHaveLength(50); expect(response.body.data.hasMore).toBe(true); expect(response.body.data.items[0].incidentId).toBe(ids[0]);
      expect(response.body.data.items.some((item: { incidentId: string }) => item.incidentId === ids[52])).toBe(false);
    }
    for (const index of [3,4]) expect((await getQueue(index)).body.data.items).toEqual([]);
    expect((await getQueue(5)).status).toBe(403); expect((await getQueue(1, '?responseService=POLICE')).status).toBe(403);
    expect((await getQueue(1, '?responseService=FIRE&limit=100000')).status).toBe(400);
  });
  it('assigned department Admin acknowledgements clear Main but retain other departments and bounded tail work', async () => {
    expect((await ack(1, ids[0], 1)).status).toBe(200); expect((await ack(1, ids[1], 1)).status).toBe(200);
    const fire = (await getQueue(1)).body.data; expect(fire.items).toHaveLength(50); expect(fire.hasMore).toBe(false);
    expect(fire.items.at(-1).incidentId).toBe(ids[51]); expect((await getQueue(2)).body.data.items[0].incidentId).toBe(ids[0]);
    const main = (await getQueue(0)).body.data;
    expect(main.acknowledgementMode).toBe('DEPARTMENT_HANDOFF'); expect(main.items[0].incidentId).toBe(ids[2]);
    expect((await getQueue(0, '?responseService=FIRE')).body.data.items[0].incidentId).toBe(ids[2]);
    expect((await ack(0, ids[2], 1)).status).toBe(403);
    expect((await ack(3, ids[2], 1)).status).toBe(404);
    expect((await getQueue(0)).body.data.items[0].incidentId).toBe(ids[2]);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: ids[0] } })).status).toBe('RESPONDING');
    const audits = await prisma.auditLog.count({ where: { actorId: users[1].id, action: 'INCIDENT_ATTENTION_ACKNOWLEDGED' } });
    expect((await ack(1, ids[0], 1)).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { actorId: users[1].id, action: 'INCIDENT_ATTENTION_ACKNOWLEDGED' } })).toBe(audits);
  });
  it('handles completion/reopening atomically and rejects a stale acknowledgement without changing another service', async () => {
    const update = (status: string) => request(app).patch(`/api/incidents/v1/${ids[0]}/services/FIRE`).set('Cookie', users[1].cookie).set('Origin', ENV.FRONTEND_URL).send({ status });
    expect((await update('RESOLVED')).status).toBe(200); expect((await ack(1, ids[0], 1)).status).toBe(409);
    expect((await update('RESPONDING')).status).toBe(200);
    const incident = await prisma.incident.findUniqueOrThrow({ where: { incidentId: ids[0] }, include: { serviceResponses: true } });
    expect(incident.attentionVersion).toBe(2); expect(incident.serviceResponses.find(item => item.service === 'FIRE')?.attentionVersion).toBe(2);
    expect(incident.serviceResponses.find(item => item.service === 'MEDICAL')?.attentionVersion).toBe(1);
    expect((await ack(1, ids[0], 1)).status).toBe(409); expect((await getQueue(1)).body.data.items[0].version).toBe(2);
    expect((await getQueue(0)).body.data.items[0]).toMatchObject({ incidentId: ids[0], version: 2 });
    const versionTime = incident.updatedAt;
    expect((await update('RESPONDING')).status).toBe(200);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: ids[0] } })).updatedAt).toEqual(versionTime);
    expect(await prisma.notificationOutbox.count({ where: { eventType: 'INCIDENT_REOPENED' } })).toBe(1);
  });
  it('drops delayed Main pushes after assigned department acknowledgement while keeping the other department eligible', async () => {
    const job = { eventType: 'INCIDENT_REOPENED', createdAt: new Date(), userIds: [users[0].id, users[1].id], audienceIds: [users[0].id, users[1].id],
      payload: { data: { incidentId: ids[0], attentionVersion: '2', serviceAttentionVersion: '2', responseService: 'FIRE' } } };
    expect(await notificationRelevant(job, users[1].id)).toBe(true);
    expect((await ack(1, ids[0], 2)).status).toBe(200);
    expect(await notificationRelevant(job, users[1].id)).toBe(false);
    expect((await ack(0, ids[0], 2)).status).toBe(403);
    expect(await notificationRelevant(job, users[0].id)).toBe(false);
    const medicalCreation = { ...job, eventType: 'INCIDENT_CREATED', userIds: [users[2].id], audienceIds: [users[2].id],
      payload: { data: { incidentId: ids[0], attentionVersion: '1', serviceAttentionVersion: '1' } } };
    expect(await notificationRelevant(medicalCreation, users[2].id)).toBe(true);
  });
  it('Main Admin cannot resolve overall or individual department responses through real HTTP routes', async () => {
    const before = await prisma.incident.findUniqueOrThrow({ where: { incidentId: ids[3] }, include: { serviceResponses: true } });
    expect((await request(app).put(`/api/incidents/v1/${ids[3]}`).set('Cookie', users[0].cookie).set('Origin', ENV.FRONTEND_URL).send({ status: 'RESOLVED' })).status).toBe(403);
    expect((await request(app).patch(`/api/incidents/v1/${ids[3]}/services/FIRE`).set('Cookie', users[0].cookie).set('Origin', ENV.FRONTEND_URL).send({ status: 'RESOLVED' })).status).toBe(403);
    const after = await prisma.incident.findUniqueOrThrow({ where: { incidentId: ids[3] }, include: { serviceResponses: true } });
    expect(after).toEqual(before);
  });
  // Opt in only on native disposable PostgreSQL. The embedded socket harness
  // serializes SQL and must not be reported as a multi-session race test.
  it.runIf(process.env.RUN_NATIVE_ALERT_RACES === '1')('a concurrent acknowledgement cannot suppress a completed-and-reopened version', async () => {
    const update = (status: string) => request(app).patch(`/api/incidents/v1/${ids[2]}/services/FIRE`).set('Cookie', users[1].cookie).set('Origin', ENV.FRONTEND_URL).send({ status });
    const [acknowledged] = await Promise.all([ack(1, ids[2], 1), (async () => {
      expect((await update('RESOLVED')).status).toBe(200);
      expect((await update('RESPONDING')).status).toBe(200);
    })()]);
    expect([200,409]).toContain(acknowledged.status);
    const queue = (await getQueue(1)).body.data.items;
    expect(queue.find((item: { incidentId: string }) => item.incidentId === ids[2])?.version).toBe(2);
    expect((await getQueue(0)).body.data.items.find((item: { incidentId: string }) => item.incidentId === ids[2])?.version).toBe(2);
    const responses = await prisma.incidentServiceResponse.findMany({ where: { incidentId: ids[2] } });
    expect(responses.find(item => item.service === 'MEDICAL')?.attentionVersion).toBe(1);
    expect(await prisma.notificationOutbox.count({ where: { eventType: 'INCIDENT_REOPENED', payload: { path: ['data','incidentId'], equals: ids[2] } } })).toBe(1);
  });
  it.runIf(process.env.RUN_NATIVE_ALERT_RACES === '1')('competing native claims have one winner and reclamation fences stale progress and completion', async () => {
    const job = await prisma.notificationOutbox.create({ data: { eventType: 'INCIDENT_CREATED', payload: { data: { incidentId: ids[3] } }, userIds: [users[0].id], audienceIds: [users[0].id] } });
    const tokens = [randomUUID(), randomUUID()];
    const claimed = await Promise.all(tokens.map(claimToken => prisma.notificationOutbox.updateMany({
      where: { notificationOutboxId: job.notificationOutboxId, status: job.status, updatedAt: job.updatedAt, attempts: { lt: 8 } },
      data: { status: 'PROCESSING', claimToken, leaseUntil: new Date(Date.now() + 60000) },
    })));
    expect(claimed.map(item => item.count).sort()).toEqual([0,1]);
    const winner = tokens[claimed.findIndex(item => item.count === 1)];
    const owned = { notificationOutboxId: job.notificationOutboxId, status: 'PROCESSING' as const, claimToken: winner };
    expect((await prisma.notificationOutbox.updateMany({ where: owned, data: { leaseUntil: new Date(Date.now() - 1000) } })).count).toBe(1);
    expect((await prisma.notificationOutbox.updateMany({ where: { ...owned, leaseUntil: { gt: new Date() } }, data: { deliveredDevices: { push: 'expired-progress' } } })).count).toBe(0);
    expect((await prisma.notificationOutbox.updateMany({ where: { notificationOutboxId: job.notificationOutboxId, status: 'PROCESSING', leaseUntil: { lt: new Date() } }, data: { status: 'FAILED', claimToken: null, leaseUntil: null, nextAttemptAt: new Date() } })).count).toBe(1);
    const recovered = await prisma.notificationOutbox.findUniqueOrThrow({ where: { notificationOutboxId: job.notificationOutboxId } });
    const replacement = randomUUID();
    expect((await prisma.notificationOutbox.updateMany({ where: { notificationOutboxId: job.notificationOutboxId, status: recovered.status, updatedAt: recovered.updatedAt, attempts: { lt: 8 } }, data: { status: 'PROCESSING', claimToken: replacement, leaseUntil: new Date(Date.now() + 60000) } })).count).toBe(1);
    for (const data of [{ deliveredDevices: { push: 'stale-device' } }, { status: 'COMPLETED' as const }, { status: 'FAILED' as const }]) {
      expect((await prisma.notificationOutbox.updateMany({ where: owned, data })).count).toBe(0);
    }
    const current = { ...owned, claimToken: replacement };
    expect((await prisma.notificationOutbox.updateMany({ where: { ...current, leaseUntil: { gt: new Date() } }, data: { deliveredDevices: { push: 'current-device' } } })).count).toBe(1);
    expect((await prisma.notificationOutbox.updateMany({ where: current, data: { status: 'COMPLETED', claimToken: null, leaseUntil: null } })).count).toBe(1);
    expect((await prisma.notificationOutbox.findUniqueOrThrow({ where: { notificationOutboxId: job.notificationOutboxId } })).deliveredDevices).toEqual(['current-device']);
  });
  it('fresh middleware and transactional identity reject revoked/deactivated or reassigned actors', async () => {
    // This final test deliberately changes only its synthetic actor.
    await prisma.user.update({ where: { id: users[1].id }, data: { department: 'POLICE' } });
    expect((await getQueue(1, '?responseService=FIRE')).status).toBe(403); expect((await ack(1, ids[0], 2)).status).toBe(404);
    await prisma.user.update({ where: { id: users[1].id }, data: { status: 'INACTIVE' } }); expect((await getQueue(1)).status).toBe(403);
  });
});
