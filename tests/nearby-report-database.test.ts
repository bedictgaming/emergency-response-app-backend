// Real transaction/concurrency checks on a new loopback-only disposable cluster.
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('@/lib/cloudinary', () => ({ verifyUploadedAsset: async (publicId: string, userId: string) => {
  if (!publicId.startsWith(`emergency-incidents/${userId}/`)) throw new Error('Synthetic proof owner mismatch');
  return { publicId, url: 'https://evidence.invalid/synthetic-only.jpg', format: 'jpg', bytes: 100, width: 10, height: 10, phash: publicId };
} }));
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { CreateIncidentService } from '@/services/incident/create-incident-service';
import { GetAllIncidentsService } from '@/services/incident/get-all-incidents-service';
import { departmentIncidentScope } from '@/domain/department-access.policy';
import type { ResponseService } from '@/generated/prisma';

const suite = describe.runIf(process.env.RUN_NEARBY_REPORT_TESTS === '1');
const services = ['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const;
const types = new Map<ResponseService, string>();
let firstUser: string, secondUser: string, barangayId: string;
suite('native nearby emergency acceptance and repeated-submission rejection', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DISPOSABLE_DATABASE_URL || '');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/alert_disposable'
        || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
        || process.env.DATABASE_URL !== process.env.DISPOSABLE_DATABASE_URL
        || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED || ENV.EVIDENCE_DELETION_ENABLED
        || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED || ENV.CLOUDINARY.API_SECRET) throw Error('ISOLATED_NEARBY_TARGET_REQUIRED');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`)[0].name).toBe('alert_disposable');
    firstUser = (await prisma.user.create({ data: { name: 'Synthetic nearby A' } })).id;
    secondUser = (await prisma.user.create({ data: { name: 'Synthetic nearby B' } })).id;
    barangayId = (await prisma.barangay.upsert({ where: { name: 'Poblacion' }, update: { status: 'ACTIVE' }, create: { name: 'Poblacion' } })).barangayId;
    for (const service of services) types.set(service, (await prisma.incidentType.create({ data: { typeName: `${service} synthetic ${randomUUID()}` } })).typeId);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  function input(userId: string, service: ResponseService, submissionId = randomUUID(), latitude = 10.251) {
    return { submissionId, title: `Synthetic separate ${service} emergency`, description: 'Synthetic fixture; not an emergency.',
      typeId: types.get(service)!, barangayId, latitude, longitude: 123.949, reporterPhone: '09171234567',
      proofAttachment: { publicId: `emergency-incidents/${userId}/${randomUUID()}`, fileName: 'synthetic.jpg' } };
  }

  it.each(services)('accepts two concurrent distinct %s emergencies within 100 metres and warns only within authorized scope', async service => {
    const results = await Promise.all([
      CreateIncidentService(input(firstUser, service), firstUser),
      CreateIncidentService(input(secondUser, service, randomUUID(), 10.2513), secondUser),
    ]);
    expect(results.map(result => result.code)).toEqual([201, 201]);
    const persisted = await prisma.incident.findMany({ where: { typeId: types.get(service) }, include: { attachments: true, serviceResponses: true } });
    expect(persisted).toHaveLength(2);
    expect(persisted.every(row => row.attachments.length === 1 && row.serviceResponses[0].service === service)).toBe(true);
    const scope = departmentIncidentScope({ role: 'ADMIN', department: service === 'HAZARD' ? 'DRRMO' : service, isMainAdmin: false });
    const list = await GetAllIncidentsService({ scope, nearbyWarningScope: scope, includeTotal: false });
    expect(list.code).toBe(200);
    expect(list.data?.incidents).toHaveLength(2);
    expect(list.data?.incidents.every(row => 'nearbyReportWarning' in row && row.nearbyReportWarning === 'POSSIBLE_DUPLICATE')).toBe(true);
    const own = await GetAllIncidentsService({ reportedBy: firstUser, includeTotal: false });
    expect(own.data?.incidents.every(row => !('nearbyReportWarning' in row))).toBe(true);
    expect(results.every(row => !JSON.stringify(row).includes('POSSIBLE_DUPLICATE'))).toBe(true);
  });

  it('shows Main a related Medical report without revealing it to the Fire-only view of a shared report', async () => {
    const latitude = 10.2528;
    expect((await CreateIncidentService(input(secondUser, 'MEDICAL', randomUUID(), latitude), secondUser)).code).toBe(201);
    const shared = { ...input(firstUser, 'FIRE', randomUUID(), latitude), category: 'other', requestedServices: ['FIRE', 'MEDICAL'] as ResponseService[] };
    expect((await CreateIncidentService(shared, firstUser)).code).toBe(201);
    const fire = departmentIncidentScope({ role: 'ADMIN', department: 'FIRE', isMainAdmin: false });
    const scoped = await GetAllIncidentsService({ scope: fire, nearbyWarningScope: fire, includeTotal: false, from: new Date(0) });
    const fireView = scoped.data?.incidents.find(row => row.latitude != null && Math.abs(Number(row.latitude) - latitude) < 0.00001);
    expect(fireView).toBeTruthy();
    expect(fireView).not.toHaveProperty('nearbyReportWarning');
    const main = await GetAllIncidentsService({ nearbyWarningScope: {}, includeTotal: false, limit: 5 });
    expect(main.data?.incidents.some(row => row.latitude != null && Math.abs(Number(row.latitude) - latitude) < 0.00001 && 'nearbyReportWarning' in row && row.nearbyReportWarning === 'POSSIBLE_DUPLICATE')).toBe(true);
  });

  it('persists exactly one report when one account concurrently repeats its submission ID with different uploads', async () => {
    const key = randomUUID(), title = `Synthetic replay ${key}`;
    const results = await Promise.all([0, 1].map(() => CreateIncidentService({ ...input(firstUser, 'FIRE', key), title }, firstUser)));
    expect(results.map(result => result.code).sort()).toEqual([201, 409]);
    expect(results.find(result => result.code === 409)).toMatchObject({ errorCode: 'DUPLICATE_SUBMISSION' });
    expect(await prisma.incident.count({ where: { title, reportedBy: firstUser } })).toBe(1);
  });

  it('scopes the same client submission ID to its authenticated reporter', async () => {
    const key = randomUUID();
    const results = await Promise.all([firstUser, secondUser].map(user => CreateIncidentService(input(user, 'POLICE', key), user)));
    expect(results.map(result => result.code)).toEqual([201, 201]);
  });

  it('still rejects reused evidence and never queues deletion of referenced evidence', async () => {
    const body = input(firstUser, 'MEDICAL');
    expect((await CreateIncidentService(body, firstUser)).code).toBe(201);
    expect((await CreateIncidentService({ ...body, submissionId: randomUUID() }, firstUser)).code).toBe(409);
    expect(await prisma.attachment.count({ where: { publicId: body.proofAttachment.publicId } })).toBe(1);
    expect(await prisma.assetCleanupJob.count({ where: { publicId: body.proofAttachment.publicId } })).toBe(0);
  });

  it('cannot attach another citizen\'s evidence', async () => {
    const body = input(secondUser, 'HAZARD');
    const count = await prisma.incident.count();
    expect((await CreateIncidentService(body, firstUser)).code).toBe(422);
    expect(await prisma.incident.count()).toBe(count);
  });
});
