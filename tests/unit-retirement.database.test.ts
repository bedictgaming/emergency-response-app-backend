// Opt-in, synthetic native PostgreSQL only. Never uses the development/live DB.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { CancelFalseIncidentService } from '@/services/incident/cancel-false-incident-service';
import { DeleteIncidentService } from '@/services/incident/delete-incident-service';
import { UpdateServiceResponseService } from '@/services/incident/update-service-response-service';
import type { JwtPayload } from '@/lib/jwt';
const suite = describe.runIf(process.env.RUN_UNIT_RETIREMENT_DATABASE_TESTS === '1');
const users: string[] = [], reports: string[] = [], units: string[] = [];
let typeId: string, locationId: string, confirmed = false;
suite('retired dispatch native transaction contracts', () => {
  beforeAll(async () => {
    const supplied = process.env.DISPOSABLE_DATABASE_URL || '', url = new URL(supplied);
    // Two explicitly approved disposable runners: hosted PostgreSQL 18 and the local synthetic cluster.
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !['5432', '55433'].includes(url.port) || url.pathname !== '/alert_disposable'
      || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable' || process.env.DATABASE_URL !== supplied || process.env.DIRECT_URL !== supplied
      || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED || ENV.API_GATEWAY_REQUIRED || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED
      || ENV.CLOUDINARY.API_SECRET || ENV.WEB_PUSH_PRIVATE_KEY || ENV.SMTP.PASS || process.env.BREVO_API_KEY || process.env.GMAIL_MAIL_REFRESH_TOKEN) throw Error('UNIT_RETIREMENT_SYNTHETIC_TARGET_REQUIRED');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`)[0].name).toBe('alert_disposable');
    confirmed = true;
    typeId = (await prisma.incidentType.create({ data: { typeName: 'Synthetic Fire retirement' } })).typeId;
    locationId = (await prisma.location.create({ data: { locationName: 'Synthetic retirement location' } })).locationId;
  });
  afterAll(async () => {
    if (confirmed) {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
      await prisma.incidentUnit.deleteMany({ where: { incidentId: { in: reports } } });
      await prisma.incident.deleteMany({ where: { incidentId: { in: reports } } });
      await prisma.unit.deleteMany({ where: { unitId: { in: units } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.location.delete({ where: { locationId } }); await prisma.incidentType.delete({ where: { typeId } });
    }
    await prisma.$disconnect();
  });
  async function fixture() {
    const id = randomUUID(), departmentId = randomUUID(); users.push(id,departmentId);
    await prisma.user.create({ data: { id, name:'Synthetic Main', role:'ADMIN', department:'MAIN', isMainAdmin:true } });
    await prisma.user.create({ data: { id:departmentId, name:'Synthetic Fire', role:'ADMIN', department:'FIRE' } });
    const session = await prisma.token.create({ data:{ userId:id,type:'REFRESH',token:`synthetic-${randomUUID()}`,expiresAt:new Date(Date.now()+3600000) } });
    const departmentSession = await prisma.token.create({ data:{ userId:departmentId,type:'REFRESH',token:`synthetic-${randomUUID()}`,expiresAt:new Date(Date.now()+3600000) } });
    const actor: JwtPayload = { sub:id,sessionId:session.id,role:'ADMIN',department:'MAIN',isMainAdmin:true,type:'access' };
    const department: JwtPayload = { sub:departmentId,sessionId:departmentSession.id,role:'ADMIN',department:'FIRE',isMainAdmin:false,type:'access' };
    const unit = await prisma.unit.create({ data:{ unitName:'Synthetic historical unit',unitType:'FIRE',status:'DEPLOYED' } }); units.push(unit.unitId);
    const report = await prisma.incident.create({ data:{ title:'Synthetic retirement fixture; not an emergency',typeId,locationId,reportedBy:id,severityLevel:'LOW',status:'RESPONDING',requestedServices:['FIRE'],
      serviceResponses:{ create:{service:'FIRE',status:'RESPONDING'} }, incidentUnits:{create:{unitId:unit.unitId,status:'ON_SCENE'}} } }); reports.push(report.incidentId);
    const flag = await prisma.incidentReviewFlag.create({ data:{incidentId:report.incidentId,department:'FIRE',flaggedBy:departmentId,reason:'Synthetic confirmed false report fixture',status:'CONFIRMED'} });
    const version = {reviewFlagId:flag.reviewFlagId,expectedReviewUpdatedAt:flag.updatedAt.toISOString(),expectedIncidentUpdatedAt:report.updatedAt.toISOString()};
    return { actor,department,unit,report,version };
  }
  it('department completion does not change a historical dispatch or unit availability', async () => {
    const f = await fixture();
    expect((await UpdateServiceResponseService(f.report.incidentId,'FIRE','RESOLVED',f.department)).code).toBe(200);
    expect((await prisma.incident.findUniqueOrThrow({where:{incidentId:f.report.incidentId}})).status).toBe('RESOLVED');
    expect((await prisma.incidentUnit.findUniqueOrThrow({where:{incidentId_unitId:{incidentId:f.report.incidentId,unitId:f.unit.unitId}}})).status).toBe('ON_SCENE');
    expect((await prisma.unit.findUniqueOrThrow({where:{unitId:f.unit.unitId}})).status).toBe('DEPLOYED');
  });
  it.each(['cancel','delete'])('%s accepts legacy On Scene without fabricating Returned and preserves its audit provenance', async action => {
    const f = await fixture(), reason='Synthetic reviewed false report for retirement test';
    const result = action==='cancel' ? await CancelFalseIncidentService(f.report.incidentId,{reason,...f.version},f.actor)
      : await DeleteIncidentService(f.report.incidentId,f.actor,{reason,confirmation:'DELETE',falseReport:f.version});
    expect(result.code).toBe(200);
    expect((await prisma.unit.findUniqueOrThrow({where:{unitId:f.unit.unitId}})).status).toBe('DEPLOYED');
    const audit = await prisma.auditLog.findFirstOrThrow({where:{actorId:f.actor.sub,action:action==='cancel'?'INCIDENT_CANCELLED_FALSE':'INCIDENT_DELETED'}});
    expect(audit.metadata).toMatchObject({retiredUnitAssignments:[{unitId:f.unit.unitId,status:'ON_SCENE'}]});
    if(action==='cancel') {
      expect((await prisma.incident.findUniqueOrThrow({where:{incidentId:f.report.incidentId}})).status).toBe('CANCELLED');
      expect((await prisma.incidentUnit.findUniqueOrThrow({where:{incidentId_unitId:{incidentId:f.report.incidentId,unitId:f.unit.unitId}}})).status).toBe('ON_SCENE');
    } else expect(await prisma.incident.findUnique({where:{incidentId:f.report.incidentId}})).toBeNull();
  });
});
