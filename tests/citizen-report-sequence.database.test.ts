// Real transactions and authenticated routes; synthetic loopback database only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
vi.mock('@/lib/cloudinary', () => ({ verifyUploadedAsset: async (publicId: string, userId: string) => {
  if (!publicId.startsWith(`emergency-incidents-staging/${userId}/`)) throw Error('SYNTHETIC_PROOF_OWNER_MISMATCH');
  return { publicId, url: 'https://evidence.invalid/synthetic.jpg', format: 'jpg', bytes: 100, width: 10, height: 10, phash: publicId };
} }));
import app from '@/app';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { signAccessToken } from '@/lib/jwt';
import { CreateIncidentService } from '@/services/incident/create-incident-service';
import { recordCitizenReportSequence } from '@/lib/citizen-report-sequence';
import { CITIZEN_REPORT_SEQUENCE_ACTION as stateAction } from '@/domain/citizen-report-sequence.policy';
import type { Department, Prisma, ResponseService } from '@/generated/prisma';

const enabled = process.env.RUN_NATIVE_CITIZEN_SEQUENCE === '1';
const services = ['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const;
const users: Array<{id: string; session: string; cookie: string}> = [];
const types = new Map<ResponseService, string>();
const staff = new Map<string, Awaited<ReturnType<typeof actor>>>();
let barangayId: string, ownsBarangay = false, confirmed = false;
async function actor(department: Department | null = null) {
  const id = randomUUID(), session = randomUUID(), role = department ? 'ADMIN' : 'USER';
  await prisma.user.create({data: {id, name: 'Synthetic sequence fixture', role, department, isMainAdmin: department === 'MAIN'}});
  await prisma.token.create({data: {id: session, userId: id, token: randomUUID(), type: 'REFRESH', expiresAt: new Date(Date.now() + 3600000)}});
  const result = {id, session, cookie: `accessToken=${signAccessToken(id, role, '15m', session)}`};
  users.push(result); return result;
}
function input(userId: string, service: ResponseService, submissionId = randomUUID()) {
  return {submissionId, title: 'Synthetic sequence report', description: 'Not an emergency.', typeId: types.get(service)!,
    barangayId, latitude: 10.251, longitude: 123.949, reporterPhone: '09171234567',
    proofAttachment: {publicId: `emergency-incidents-staging/${userId}/${randomUUID()}`, fileName: 'synthetic.jpg'}};
}
const submit = (userId: string, service: ResponseService, key?: string) => CreateIncidentService(input(userId, service, key), userId);
const receipt = (userId: string) => prisma.auditLog.findFirst({where: {entityType:'User', entityId:userId, action:stateAction}, orderBy:[{createdAt:'desc'},{auditLogId:'desc'}]});
async function reportCount(userId: string) { return prisma.incident.count({where: {reportedBy:userId}}); }

describe.runIf(enabled)('native citizen consecutive-report restriction', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DISPOSABLE_DATABASE_URL || '');
    if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost'].includes(url.hostname) || url.pathname !== '/alert_disposable'
      || process.env.DATABASE_URL !== process.env.DISPOSABLE_DATABASE_URL || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
      || process.env.DIRECT_URL !== process.env.DISPOSABLE_DATABASE_URL
      || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED
      || ENV.CLOUDINARY.API_SECRET || ENV.WEB_PUSH_PRIVATE_KEY || ENV.SMTP.PASS) throw Error('PROVIDER_FREE_NATIVE_SEQUENCE_TARGET_REQUIRED');
    expect((await prisma.$queryRaw<Array<{name:string}>>`SELECT current_database()::text AS name`)[0].name).toBe('alert_disposable');
    confirmed = true;
    for (const department of ['MAIN','FIRE','MEDICAL','POLICE','DRRMO'] as const) staff.set(department, await actor(department));
    const existing = await prisma.barangay.findUnique({where:{name:'Poblacion'}});
    ownsBarangay = !existing;
    barangayId = (existing || await prisma.barangay.create({data:{name:'Poblacion'}})).barangayId;
    for (const service of services) types.set(service, (await prisma.incidentType.create({data:{typeName:`${service} synthetic ${randomUUID()}`}})).typeId);
  });
  afterAll(async () => {
    if (!enabled || !confirmed) { await prisma.$disconnect(); return; }
    const ids = users.map(user => user.id);
    const incidents = await prisma.incident.findMany({where:{reportedBy:{in:ids}}, select:{incidentId:true,locationId:true}});
    for (const row of incidents) await prisma.notificationOutbox.deleteMany({where:{payload:{path:['data','incidentId'],equals:row.incidentId}}});
    await prisma.attachment.deleteMany({where:{incidentId:{in:incidents.map(row=>row.incidentId)}}});
    await prisma.incident.deleteMany({where:{reportedBy:{in:ids}}});
    await prisma.location.deleteMany({where:{locationId:{in:incidents.map(row => row.locationId)}}});
    await prisma.assetCleanupJob.deleteMany({where:{OR:ids.map(id => ({publicId:{startsWith:`emergency-incidents-staging/${id}/`}}))}});
    await prisma.auditLog.deleteMany({where:{OR:[{actorId:{in:ids}},{entityType:'User',entityId:{in:ids}}]}});
    await prisma.user.deleteMany({where:{id:{in:ids}}});
    await prisma.incidentType.deleteMany({where:{typeId:{in:[...types.values()]}}});
    if (barangayId && ownsBarangay) await prisma.barangay.delete({where:{barangayId}});
    await prisma.$disconnect();
  });

  it.each(services)('accepts/routes all three %s reports, then atomically revokes every citizen session', async service => {
    const user = await actor();
    await prisma.token.create({data:{userId:user.id, token:randomUUID(),type:'REFRESH',expiresAt:new Date(Date.now()+3600000)}});
    for (let n=1; n<=3; n++) {
      const response = await request(app).post('/api/incidents/v1/').set('Cookie',user.cookie).set('Origin',ENV.FRONTEND_URL).send(input(user.id,service));
      expect(response.status).toBe(201);
      expect(response.body.data?.accountDeactivated === true).toBe(n===3);
    }
    expect(await reportCount(user.id)).toBe(3);
    expect((await prisma.user.findUniqueOrThrow({where:{id:user.id}})).status).toBe('INACTIVE');
    expect(await prisma.token.count({where:{userId:user.id,revokedAt:null}})).toBe(0);
    expect(await prisma.auditLog.count({where:{entityId:user.id,action:'CITIZEN_AUTO_DEACTIVATED'}})).toBe(1);
    const reports = await prisma.incident.findMany({where:{reportedBy:user.id},include:{attachments:true,serviceResponses:true}});
    for (const report of reports) {
      expect(report.status).toBe('RESPONDING'); expect(report.attachments).toHaveLength(1);
      expect(report.serviceResponses.map(row=>row.service)).toEqual([service]);
      const job = await prisma.notificationOutbox.findFirstOrThrow({where:{payload:{path:['data','incidentId'],equals:report.incidentId}}});
      expect([...job.userIds].sort()).toEqual([staff.get('MAIN')!.id,staff.get(service==='HAZARD'?'DRRMO':service)!.id].sort());
    }
    expect((await submit(user.id,service)).code).toBe(403);
    expect(await reportCount(user.id)).toBe(3);
    expect((await request(app).get('/api/incidents/v1/').set('Cookie',user.cookie)).status).toBe(403);
  });

  it('serializes four concurrent distinct reports: exactly three accepted and one restriction', async () => {
    const user = await actor();
    const responses = await Promise.all([0,1,2,3].map(()=>submit(user.id,'MEDICAL')));
    expect(responses.map(row=>row.code).sort()).toEqual([201,201,201,403]);
    expect(responses.filter(row=>row.data?.accountDeactivated)).toHaveLength(1);
    expect(await reportCount(user.id)).toBe(3);
  });

  it('does not count concurrent replay, failed proof, or a rejected payload as additional reports', async () => {
    const user = await actor(), key = randomUUID();
    const replies = await Promise.all([0,1].map(()=>submit(user.id,'POLICE',key)));
    expect(replies.map(row=>row.code).sort()).toEqual([201,409]);
    expect(await reportCount(user.id)).toBe(1);
    const invalid = {...input(user.id,'POLICE'), proofAttachment:input(staff.get('MAIN')!.id,'POLICE').proofAttachment};
    expect((await CreateIncidentService(invalid,user.id)).code).toBe(422);
    expect((await request(app).post('/api/incidents/v1/').set('Cookie',user.cookie).set('Origin',ENV.FRONTEND_URL).send({title:'x'})).status).toBe(400);
    expect((await submit(user.id,'POLICE')).data?.accountDeactivated).not.toBe(true);
    expect((await submit(user.id,'POLICE')).data?.accountDeactivated).toBe(true);
  });

  it('an intervening department breaks the streak; multi-service Other uses common routed services', async () => {
    const user = await actor();
    for (const service of ['MEDICAL','FIRE','MEDICAL','MEDICAL'] as const) expect((await submit(user.id,service)).data?.accountDeactivated).not.toBe(true);
    expect((await submit(user.id,'MEDICAL')).data?.accountDeactivated).toBe(true);
    const other = await actor();
    for (const [index, requestedServices] of ([['FIRE','MEDICAL'],['FIRE','HAZARD'],['FIRE','POLICE']] as ResponseService[][]).entries()) {
      const response = await CreateIncidentService({...input(other.id,'FIRE'),category:'other',requestedServices},other.id);
      expect(response.code).toBe(201); expect(response.data?.accountDeactivated===true).toBe(index===2);
    }
  });

  it('uses the persisted server-time window after reconnect, unaffected by report resolution', async () => {
    const user = await actor();
    await submit(user.id,'HAZARD'); await submit(user.id,'HAZARD');
    const saved = await receipt(user.id);
    const metadata = saved!.metadata as unknown as {version:number;reports:Array<{submittedAt:number}>};
    metadata.reports.forEach(row=>{row.submittedAt=Date.now()-301000;});
    await prisma.auditLog.update({where:{auditLogId:saved!.auditLogId},data:{metadata:metadata as Prisma.InputJsonValue}});
    await prisma.$disconnect();
    expect((await submit(user.id,'HAZARD')).data?.accountDeactivated).not.toBe(true);
    expect((await submit(user.id,'HAZARD')).data?.accountDeactivated).not.toBe(true);
    await prisma.incident.updateMany({where:{reportedBy:user.id},data:{status:'RESOLVED'}});
    expect((await submit(user.id,'HAZARD')).data?.accountDeactivated).toBe(true);
  });

  it('rolls back restriction, token revocation, audit and counter together on transaction failure', async () => {
    const user = await actor(); await submit(user.id,'FIRE'); await submit(user.id,'FIRE');
    const before = await receipt(user.id);
    await expect(prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${user.id} FOR UPDATE`;
      expect(await recordCitizenReportSequence(tx,user.id,{incidentId:randomUUID(),services:['FIRE']})).toBe(true);
      throw Error('SYNTHETIC_ROLLBACK');
    })).rejects.toThrow('SYNTHETIC_ROLLBACK');
    expect((await prisma.user.findUniqueOrThrow({where:{id:user.id}})).status).toBe('ACTIVE');
    expect(await prisma.token.count({where:{userId:user.id,revokedAt:null}})).toBe(1);
    expect((await receipt(user.id))!.auditLogId).toBe(before!.auditLogId);
    expect(await prisma.auditLog.count({where:{entityId:user.id,action:'CITIZEN_AUTO_DEACTIVATED'}})).toBe(0);
    expect(await reportCount(user.id)).toBe(2);
  });

  it('only Main Admin can reactivate, resets the streak, and never revives old sessions', async () => {
    const user = await actor();
    for (let n=0;n<3;n++) await submit(user.id,'MEDICAL');
    const change = (cookie:string) => request(app).patch(`/api/users/v1/${user.id}/status`).set('Cookie',cookie).set('Origin',ENV.FRONTEND_URL).send({status:'ACTIVE'});
    expect((await change(staff.get('MEDICAL')!.cookie)).status).toBe(403);
    expect((await change(staff.get('MAIN')!.cookie)).status).toBe(200);
    expect((await request(app).get('/api/incidents/v1/').set('Cookie',user.cookie)).status).toBe(401);
    for (let n=1;n<=3;n++) expect((await submit(user.id,'MEDICAL')).data?.accountDeactivated===true).toBe(n===3);
  });

  it('keeps staff submissions exempt from citizen deactivation', async () => {
    const main = staff.get('MAIN')!;
    for (let n=0;n<3;n++) expect((await submit(main.id,'FIRE')).code).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({where:{id:main.id}})).status).toBe('ACTIVE');
    expect(await receipt(main.id)).toBeNull();
  });
});
