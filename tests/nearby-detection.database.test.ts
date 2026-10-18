// Actual HTTP/Prisma reads on the native gate's empty synthetic loopback database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '@/app';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { signAccessToken } from '@/lib/jwt';
import type { Department, ResponseService } from '@/generated/prisma';

const enabled = process.env.RUN_NATIVE_NEARBY_DETECTION === '1';
const users: Array<{ id: string; session: string; cookie: string }> = [];
const incidents: string[] = [], types: string[] = [];
let locationId: string;
const endpoint = '/api/incidents/v1/nearby-detection';
const detect = (index: number, body: object) => request(app).post(endpoint).set('Cookie', users[index].cookie).set('Origin', ENV.FRONTEND_URL).send(body);
describe.runIf(enabled)('native nearby map HTTP privacy and department scope', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DISPOSABLE_DATABASE_URL || '');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/alert_disposable'
      || process.env.DATABASE_URL !== process.env.DISPOSABLE_DATABASE_URL || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
      || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED
      || ENV.CLOUDINARY.API_SECRET || ENV.WEB_PUSH_PRIVATE_KEY || ENV.SMTP.PASS) throw Error('PROVIDER_FREE_NATIVE_NEARBY_TARGET_REQUIRED');
    for (const department of [null, null, 'MAIN', 'FIRE', 'MEDICAL', 'POLICE', 'DRRMO'] as const) {
      const id = randomUUID(), session = randomUUID(), role = department ? 'ADMIN' : 'USER';
      await prisma.user.create({ data: { id, name: 'Synthetic map native', role, department: department as Department | null,
        isMainAdmin: department === 'MAIN', emailVerified: new Date() } });
      await prisma.token.create({ data: { id: session, userId: id, token: randomUUID(), type: 'REFRESH', expiresAt: new Date(Date.now() + 3600000) } });
      users.push({ id, session, cookie: `accessToken=${signAccessToken(id, role, '15m', session)}` });
    }
    locationId = (await prisma.location.create({ data: { locationName: 'Synthetic map point', address: 'Not an emergency' } })).locationId;
  });
  afterAll(async () => {
    if (!enabled) return;
    await prisma.incident.deleteMany({ where: { incidentId: { in: incidents } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    await prisma.incidentType.deleteMany({ where: { typeId: { in: types } } });
    if (locationId) await prisma.location.delete({ where: { locationId } });
    await prisma.$disconnect();
  });
  it.each(['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const)('detects only authorized active %s peers within 100m without citizen identity leakage', async service => {
    const typeId = (await prisma.incidentType.create({ data: { typeName: `Synthetic native ${service} ${randomUUID()}` } })).typeId;
    types.push(typeId);
    const created: string[] = [];
    for (const [owner, latitude] of [[0, 10.251], [1, 10.2513], [1, 10.254]] as const) {
      const incidentId = randomUUID(); incidents.push(incidentId); created.push(incidentId);
      await prisma.incident.create({ data: { incidentId, title: 'Synthetic map report', typeId, locationId, reportedBy: users[owner].id,
        latitude, longitude: 123.949, severityLevel: 'LOW', status: 'RESPONDING', verificationStatus: 'VERIFIED', requestedServices: [service as ResponseService] } });
    }
    const [center, peer] = created;
    const departmentIndex = 3 + ['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'].indexOf(service);
    for (const actor of [2, departmentIndex]) {
      const response = await detect(actor, { kind: 'department', incidentId: center });
      expect(response.status).toBe(200);
      expect(response.body.data.center).toEqual({ latitude: 10.251, longitude: 123.949 });
      expect(response.body.data.items.map((item: { incidentId: string }) => item.incidentId)).toEqual([peer]);
      expect(response.body.data.items[0].distanceMeters).toBeLessThanOrEqual(100);
      expect(JSON.stringify(response.body)).not.toContain('Synthetic map report');
    }
    const citizen = await detect(0, { kind: 'citizen', latitude: 10.251, longitude: 123.949, services: [service] });
    expect(citizen.status).toBe(200); expect(citizen.body.data.nearby).toBe(true);
    expect(Object.keys(citizen.body.data).sort()).toEqual(['active', 'complete', 'nearby', 'radiusMeters']);
    expect(JSON.stringify(citizen.body)).not.toContain(peer);
    const unrelated = departmentIndex === 3 ? 4 : 3;
    expect((await detect(unrelated, { kind: 'department', incidentId: center })).status).toBe(403);
    await prisma.incident.update({ where: { incidentId: peer }, data: { status: 'RESOLVED' } });
    const after = await detect(departmentIndex, { kind: 'department', incidentId: center });
    expect(after.body.data).toMatchObject({ nearby: false, complete: true, items: [] });
    expect((await detect(0, { kind: 'citizen', latitude: 10.251, longitude: 123.949, services: [service] })).body.data.nearby).toBe(false);
  });
  it('rejects client scope/coordinate overrides and citizen use of the operational mode', async () => {
    expect((await detect(0, { kind: 'department', incidentId: incidents[0] })).status).toBe(403);
    expect((await detect(3, { kind: 'department', incidentId: incidents[0], latitude: 10.251, longitude: 123.949, department: 'MAIN' })).status).toBe(400);
    expect(await prisma.notificationOutbox.count()).toBe(0);
  });
  it('rejects a revoked session before any private map read', async () => {
    await prisma.token.update({ where: { id: users[3].session }, data: { revokedAt: new Date() } });
    expect((await detect(3, { kind: 'department', incidentId: incidents[0] })).status).toBe(401);
  });
});
