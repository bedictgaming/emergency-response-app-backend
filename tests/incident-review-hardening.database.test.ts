// Synthetic-only native PostgreSQL gate; no hosted database or providers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import type { JwtPayload } from '@/lib/jwt';
import { FlagIncidentService, ReviewIncidentFlagService, CorrectIncidentFlagService } from '@/services/incident/review-incident-service';
import { DeleteIncidentService } from '@/services/incident/delete-incident-service';
import { CancelFalseIncidentService } from '@/services/incident/cancel-false-incident-service';
import { CreateTaskService } from '@/services/task/create-task-service';
import { VerifyIncidentService } from '@/services/incident/verify-incident-service';
import { GetAllIncidentsService } from '@/services/incident/get-all-incidents-service';
import { listIncidentAttention } from '@/services/incident/incident-attention-service';
import { UpdateServiceResponseService } from '@/services/incident/update-service-response-service';
import { AnalyticsRepository } from '@/repositories/analytics.repository';
import request from 'supertest';
import app from '@/app';
import { signAccessToken } from '@/lib/jwt';
import { subscribeEmergencyEvents, type EmergencyEvent } from '@/lib/events';
import type { Department, Role } from '@/generated/prisma';

const suite = describe.runIf(process.env.RUN_INCIDENT_REVIEW_HARDENING_TESTS === '1');
const users: string[] = [];
let typeId: string, locationId: string, confirmedTarget = false;
const notes = 'Synthetic investigation found this was not a genuine emergency.';

async function actor(main: boolean, department: Department = 'FIRE', role: Role = 'ADMIN'): Promise<JwtPayload> {
  const id = randomUUID(); users.push(id);
  await prisma.user.create({ data: { id, name: 'Synthetic review fixture', role, department: role === 'USER' ? null : main ? 'MAIN' : department, isMainAdmin: main } });
  const session = await prisma.token.create({ data: { userId: id, type: 'REFRESH', token: `synthetic-${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000) } });
  return { sub: id, sessionId: session.id, type: 'access', role, department: role === 'USER' ? null : main ? 'MAIN' : department, isMainAdmin: main };
}
async function incident(user: JwtPayload, closed = false) {
  return prisma.incident.create({ data: { title: 'Synthetic native review fixture; no emergency', reportedBy: user.sub, typeId, locationId, severityLevel: 'MEDIUM',
    requestedServices: ['FIRE'], status: closed ? 'CLOSED' : 'RESPONDING', verificationStatus: 'VERIFIED',
    serviceResponses: { create: { service: 'FIRE', status: closed ? 'RESOLVED' : 'RESPONDING' } },
  } });
}

suite('native false-report review hardening', () => {
  beforeAll(async () => {
    const supplied = process.env.DISPOSABLE_DATABASE_URL || '';
    const url = new URL(supplied);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/alert_disposable'
        || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
        || process.env.DATABASE_URL !== supplied || process.env.DIRECT_URL !== supplied
        || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED || ENV.API_GATEWAY_REQUIRED
        || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED
        || ENV.CLOUDINARY.API_SECRET || ENV.WEB_PUSH_PRIVATE_KEY || ENV.SMTP.PASS || process.env.BREVO_API_KEY) throw Error('ISOLATED_NATIVE_REVIEW_TARGET_REQUIRED');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`)[0].name).toBe('alert_disposable');
    confirmedTarget = true;
    typeId = (await prisma.incidentType.create({ data: { typeName: `Synthetic Fire review ${randomUUID()}` } })).typeId;
    locationId = (await prisma.location.create({ data: { locationName: 'Synthetic native review location' } })).locationId;
  });
  afterAll(async () => {
    if (confirmedTarget) {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
      const syntheticScope = { incident: { reportedBy: { in: users } } };
      await prisma.attachment.deleteMany({ where: syntheticScope });
      await prisma.task.deleteMany({ where: syntheticScope });
      await prisma.incidentUnit.deleteMany({ where: syntheticScope });
      await prisma.incident.deleteMany({ where: { reportedBy: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      if (locationId) await prisma.location.delete({ where: { locationId } });
      if (typeId) await prisma.incidentType.delete({ where: { typeId } });
    }
    await prisma.$disconnect();
  });

  for (const action of ['flag', 'review', 'correct', 'delete', 'resolve', 'cancel', 'early-delete']) {
    it.each(['inactive', 'demoted', 'transferred', 'session-revoked'])(`rejects ${action} after a competing %s commits before authority is locked`, async change => {
      const user = await actor(!['flag', 'resolve'].includes(action));
      const report = await incident(user, action === 'delete');
      const flag = await prisma.incidentReviewFlag.create({ data: { incidentId: report.incidentId, department: 'FIRE', flaggedBy: user.sub, reason: notes, status: ['correct', 'cancel', 'early-delete'].includes(action) ? 'CONFIRMED' : 'PENDING' } });
      const input = { status: 'CONFIRMED' as const, reviewNotes: notes, expectedUpdatedAt: flag.updatedAt.toISOString() };
      const version = { reviewFlagId: flag.reviewFlagId, expectedReviewUpdatedAt: flag.updatedAt.toISOString(), expectedIncidentUpdatedAt: report.updatedAt.toISOString() };
      const run = () => action === 'flag' ? FlagIncidentService(report.incidentId, notes, user)
        : action === 'review' ? ReviewIncidentFlagService(report.incidentId, flag.reviewFlagId, input, user)
        : action === 'correct' ? CorrectIncidentFlagService(report.incidentId, flag.reviewFlagId, input, user)
        : action === 'delete' ? DeleteIncidentService(report.incidentId, user, { reason: notes, confirmation: 'DELETE' })
        : action === 'early-delete' ? DeleteIncidentService(report.incidentId, user, { reason: notes, confirmation: 'DELETE', falseReport: version })
        : action === 'cancel' ? CancelFalseIncidentService(report.incidentId, { reason: notes, ...version }, user)
        : UpdateServiceResponseService(report.incidentId, 'FIRE', 'RESOLVED', user);
      const mutation = new pg.Client({ connectionString: process.env.DISPOSABLE_DATABASE_URL, connectionTimeoutMillis: 5000 });
      let pending: ReturnType<typeof run> | undefined;
      try {
        await mutation.connect();
        const pid = Number((await mutation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        await mutation.query('BEGIN');
        // Session-only revocation intentionally holds Token, not User: logout
        // uses this path, and the action must block behind the session lock.
        if (change === 'session-revoked') await mutation.query('UPDATE "Token" SET "revokedAt"=now() WHERE id=$1', [user.sessionId]);
        else {
          await mutation.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [user.sub]);
          if (change === 'inactive') await mutation.query('UPDATE "User" SET status=\'INACTIVE\' WHERE id=$1', [user.sub]);
          if (change === 'demoted') await mutation.query('UPDATE "User" SET role=\'USER\',department=NULL,is_main_admin=false WHERE id=$1', [user.sub]);
          if (change === 'transferred') await mutation.query('UPDATE "User" SET department=\'MEDICAL\',is_main_admin=false WHERE id=$1', [user.sub]);
        }
        await mutation.query('SELECT count(*) FROM pg_stat_activity');
        pending = run();
        let waiting = false;
        const deadline = Date.now() + 4000;
        while (!waiting && Date.now() < deadline) {
          await mutation.query('SELECT pg_stat_clear_snapshot()');
          waiting = Boolean((await mutation.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting);
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        await mutation.query('COMMIT');
        expect((await pending).code).toBe(403);
        expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: report.incidentId } })).status).toBe(report.status);
        expect((await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { reviewFlagId: flag.reviewFlagId } })).status).toBe(flag.status);
        expect(await prisma.auditLog.count({ where: { actorId: user.sub } })).toBe(0);
        expect(await prisma.assetCleanupJob.count()).toBe(0);
      } finally {
        await mutation.query('ROLLBACK').catch(() => undefined);
        await pending?.catch(() => undefined);
        await mutation.end().catch(() => undefined);
      }
    }, 15000);
  }

  it('cancels a multi-service false report without Resolve and keeps records, completed history and citizen privacy', async () => {
    const main = await actor(true), fire = await actor(false), drrmo = await actor(false, 'DRRMO'), citizen = await actor(false, 'FIRE', 'USER');
    const report = await prisma.incident.create({ data: { title: 'Synthetic false cancellation; no emergency', typeId, locationId, reportedBy: citizen.sub, severityLevel: 'MEDIUM',
      status: 'RESPONDING', verificationStatus: 'VERIFIED', requestedServices: ['FIRE', 'HAZARD'],
      serviceResponses: { create: [{ service: 'FIRE', status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: fire.sub }, { service: 'HAZARD', status: 'RESPONDING' }] } } });
    const proof = await prisma.attachment.create({ data: { incidentId: report.incidentId, fileName: 'synthetic-proof', fileType: 'image/jpeg', fileUrl: 'https://example.invalid/synthetic-proof', uploadedBy: citizen.sub } });
    expect((await FlagIncidentService(report.incidentId, notes, drrmo)).code).toBe(200);
    let flag = await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { incidentId_department: { incidentId: report.incidentId, department: 'DRRMO' } } });
    expect((await ReviewIncidentFlagService(report.incidentId, flag.reviewFlagId, { status: 'CONFIRMED', reviewNotes: notes, expectedUpdatedAt: flag.updatedAt.toISOString() }, main)).code).toBe(200);
    flag = await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { reviewFlagId: flag.reviewFlagId } });
    const before = await prisma.incident.findUniqueOrThrow({ where: { incidentId: report.incidentId }, include: { serviceResponses: true } });
    const input = { reason: notes, reviewFlagId: flag.reviewFlagId, expectedReviewUpdatedAt: flag.updatedAt.toISOString(), expectedIncidentUpdatedAt: before.updatedAt.toISOString() };
    const cookie = (user: JwtPayload) => `accessToken=${signAccessToken(user.sub, user.role, '15m', user.sessionId!)}`;
    const endpoint = `/api/incidents/v1/${report.incidentId}/cancel-confirmed-false`;
    expect((await request(app).post(endpoint).set('Origin', 'http://localhost:3000').set('Cookie', cookie(drrmo)).send(input)).status).toBe(403);
    expect((await request(app).post(endpoint).set('Origin', 'http://localhost:3000').set('Cookie', cookie(main)).send(input)).status).toBe(200);
    expect((await CancelFalseIncidentService(report.incidentId, input, main)).code).toBe(200);
    expect(await prisma.auditLog.count({ where: { entityId: report.incidentId, action: 'INCIDENT_CANCELLED_FALSE' } })).toBe(1);
    const after = await prisma.incident.findUniqueOrThrow({ where: { incidentId: report.incidentId }, include: { serviceResponses: true, attachments: true } });
    expect(after.status).toBe('CANCELLED'); expect(after.attachments.map(row => row.attachmentId)).toEqual([proof.attachmentId]);
    expect((await listIncidentAttention(main))?.items.some(item => item.incidentId === report.incidentId)).toBe(false);
    expect((await listIncidentAttention(drrmo))?.items.some(item => item.incidentId === report.incidentId)).toBe(false);
    expect(await prisma.notificationOutbox.count()).toBe(0); expect(await prisma.assetCleanupJob.count()).toBe(0);
    expect(after.serviceResponses.find(row => row.service === 'FIRE')).toEqual(before.serviceResponses.find(row => row.service === 'FIRE'));
    expect(after.serviceResponses.find(row => row.service === 'HAZARD')).toMatchObject({ status: 'CANCELLED', resolvedAt: null, resolvedBy: null });
    for (const responseService of ['FIRE', 'HAZARD'] as const) {
      const list = await GetAllIncidentsService({ responseService, serviceStatuses: ['CANCELLED'], scope: { incidentId: report.incidentId } });
      expect(list.data?.incidents).toHaveLength(1); expect(list.data?.summary.cancelled).toBe(1); expect(list.data?.summary.resolved).toBe(0);
      expect(list.data?.pagination.total).toBe(1);
      expect((await GetAllIncidentsService({ responseService, serviceStatuses: ['RESOLVED'], scope: { incidentId: report.incidentId } })).data?.incidents).toHaveLength(0);
    }
    const read = await request(app).get(`/api/incidents/v1/${report.incidentId}`).set('Cookie', cookie(citizen));
    expect(read.status).toBe(200); expect(read.body.data.incident.status).toBe('CANCELLED');
    expect(read.body.data.incident).not.toHaveProperty('reviewNotices'); expect(read.body.data.incident).not.toHaveProperty('reviewFlags');
    expect((await UpdateServiceResponseService(report.incidentId, 'HAZARD', 'RESOLVED', drrmo)).code).toBe(409);
    expect((await FlagIncidentService(report.incidentId, notes, fire)).code).toBe(409);
    expect((await CreateTaskService(report.incidentId, { taskName: 'Synthetic blocked task' }, main.sub)).code).toBe(400);
    // Classification correction does not reactivate cancellation or analytics.
    expect((await CorrectIncidentFlagService(report.incidentId, flag.reviewFlagId, { reviewNotes: 'Synthetic correction of the earlier classification.', expectedUpdatedAt: flag.updatedAt.toISOString() }, main)).code).toBe(200);
    expect((await new AnalyticsRepository().getIncidentsByType({ scope: { incidentId: report.incidentId } })).totalIncidents).toBe(0);
    await prisma.incident.update({ where: { incidentId: report.incidentId }, data: { verificationStatus: 'PENDING' } });
    expect((await VerifyIncidentService(report.incidentId, { verificationStatus: 'VERIFIED' }, main.sub)).code).toBe(409);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: report.incidentId } })).status).toBe('CANCELLED');
  }, 30000);

  it('permits deliberate confirmed-false early deletion but not suspicion, stale versions or unfinished tasks', async () => {
    const main = await actor(true), fire = await actor(false), report = await incident(fire);
    let flag = await prisma.incidentReviewFlag.create({ data: { incidentId: report.incidentId, department: 'FIRE', flaggedBy: fire.sub, reason: notes } });
    const version = () => ({ reviewFlagId: flag.reviewFlagId, expectedReviewUpdatedAt: flag.updatedAt.toISOString(), expectedIncidentUpdatedAt: report.updatedAt.toISOString() });
    expect((await DeleteIncidentService(report.incidentId, main, { reason: notes, confirmation: 'DELETE', falseReport: version() })).code).toBe(409);
    expect((await ReviewIncidentFlagService(report.incidentId, flag.reviewFlagId, { status: 'CONFIRMED', reviewNotes: notes, expectedUpdatedAt: flag.updatedAt.toISOString() }, main)).code).toBe(200);
    flag = await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { reviewFlagId: flag.reviewFlagId } });
    expect((await DeleteIncidentService(report.incidentId, main, { reason: notes, confirmation: 'delete', falseReport: version() })).code).toBe(400);
    const task = await prisma.task.create({ data: { incidentId: report.incidentId, taskName: 'Synthetic outstanding task' } });
    expect((await DeleteIncidentService(report.incidentId, main, { reason: notes, confirmation: 'DELETE', falseReport: version() })).code).toBe(409);
    expect((await CancelFalseIncidentService(report.incidentId, { reason: notes, ...version() }, main)).code).toBe(409);
    await prisma.task.update({ where: { taskId: task.taskId }, data: { status: 'DONE' } });
    expect((await DeleteIncidentService(report.incidentId, main, { reason: notes, confirmation: 'DELETE', falseReport: version() })).code).toBe(200);
    expect(await prisma.incident.findUnique({ where: { incidentId: report.incidentId } })).toBeNull();
    expect(await prisma.incidentServiceResponse.count({ where: { incidentId: report.incidentId } })).toBe(0);
    expect(await prisma.task.count({ where: { incidentId: report.incidentId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: report.incidentId, action: 'INCIDENT_DELETED' } })).toBe(1);
  });

  it.each(['cancel', 'delete'])('rejects %s when a competing correction commits while the incident lock is held', async action => {
    const main = await actor(true), fire = await actor(false), report = await incident(fire);
    const flag = await prisma.incidentReviewFlag.create({ data: { incidentId: report.incidentId, department: 'FIRE', flaggedBy: fire.sub, reason: notes, status: 'CONFIRMED' } });
    const version = { reviewFlagId: flag.reviewFlagId, expectedReviewUpdatedAt: flag.updatedAt.toISOString(), expectedIncidentUpdatedAt: report.updatedAt.toISOString() };
    const mutation = new pg.Client({ connectionString: process.env.DISPOSABLE_DATABASE_URL });
    let pending: Promise<{ code: number }> | undefined;
    try {
      await mutation.connect(); await mutation.query('BEGIN');
      const pid = Number((await mutation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await mutation.query('SELECT incident_id FROM incidents WHERE incident_id=$1 FOR UPDATE', [report.incidentId]);
      await mutation.query('SELECT count(*) FROM pg_stat_activity');
      pending = action === 'cancel' ? CancelFalseIncidentService(report.incidentId, { reason: notes, ...version }, main)
        : DeleteIncidentService(report.incidentId, main, { reason: notes, confirmation: 'DELETE', falseReport: version });
      let waiting = false;
      const deadline = Date.now() + 4000;
      while (!waiting && Date.now() < deadline) {
        await mutation.query('SELECT pg_stat_clear_snapshot()');
        waiting = Boolean((await mutation.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting);
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await mutation.query('UPDATE incident_review_flags SET status=\'DISMISSED\',updated_at=now() WHERE review_flag_id=$1', [flag.reviewFlagId]);
      await mutation.query('COMMIT');
      expect((await pending).code).toBe(409);
      expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: report.incidentId } })).status).toBe('RESPONDING');
      expect(await prisma.auditLog.count({ where: { entityId: report.incidentId } })).toBe(0);
    } finally { await mutation.query('ROLLBACK').catch(() => undefined); await pending?.catch(() => undefined); await mutation.end(); }
  }, 15000);

  it('keeps history/response work intact and restores analytics only after all confirmations are corrected', async () => {
    const fire = await actor(false), main = await actor(true), report = await incident(fire);
    const repository = new AnalyticsRepository(), scope = { reportedBy: fire.sub };
    expect((await FlagIncidentService(report.incidentId, notes, fire)).code).toBe(200);
    let flag = await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { incidentId_department: { incidentId: report.incidentId, department: 'FIRE' } } });
    expect((await repository.getIncidentsByType({ scope })).totalIncidents).toBe(1);
    expect((await ReviewIncidentFlagService(report.incidentId, flag.reviewFlagId, { status: 'CONFIRMED', reviewNotes: notes, expectedUpdatedAt: flag.updatedAt.toISOString() }, main)).code).toBe(200);
    const other = await prisma.incidentReviewFlag.create({ data: { incidentId: report.incidentId, department: 'MEDICAL', reason: notes, flaggedBy: main.sub, reviewedBy: main.sub, status: 'CONFIRMED', reviewNotes: notes } });
    expect((await repository.getIncidentsByBarangay({ scope })).totalIncidents).toBe(0);
    expect((await repository.getIncidentsByType({ scope })).totalIncidents).toBe(0);
    expect((await repository.getResolvedSummary({ scope })).totalHistorical).toBe(0);
    flag = await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { reviewFlagId: flag.reviewFlagId } });
    const correction = { reviewNotes: 'Synthetic on-site check corrected the earlier decision.', expectedUpdatedAt: flag.updatedAt.toISOString() };
    expect((await CorrectIncidentFlagService(report.incidentId, flag.reviewFlagId, correction, main)).code).toBe(200);
    expect((await CorrectIncidentFlagService(report.incidentId, flag.reviewFlagId, correction, main)).code).toBe(409);
    expect((await repository.getIncidentsByType({ scope })).totalIncidents).toBe(0);
    expect((await CorrectIncidentFlagService(report.incidentId, other.reviewFlagId, { ...correction, expectedUpdatedAt: other.updatedAt.toISOString() }, main)).code).toBe(200);
    expect((await repository.getIncidentsByType({ scope })).totalIncidents).toBe(1);
    expect((await repository.getIncidentsByBarangay({ scope })).totalIncidents).toBe(1);
    expect((await repository.getResolvedSummary({ scope })).totalHistorical).toBe(1);
    expect(await prisma.auditLog.count({ where: { actorId: main.sub, action: 'INCIDENT_FLAG_REVIEWED' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { actorId: main.sub, action: 'INCIDENT_FLAG_CORRECTED' } })).toBe(2);
    expect((await prisma.incident.findUniqueOrThrow({ where: { incidentId: report.incidentId }, include: { serviceResponses: true } }))).toMatchObject({ status: 'RESPONDING', verificationStatus: 'VERIFIED', serviceResponses: [{ status: 'RESPONDING' }] });
    // Ordinary authorized completion remains available after review correction.
    expect((await UpdateServiceResponseService(report.incidentId, 'FIRE', 'RESOLVED', fire)).code).toBe(200);
  });

  it('shares committed DRRMO decisions with assigned departments only, with no extra mutation authority or operational effects', async () => {
    const main = await actor(true), citizen = await actor(false, 'FIRE', 'USER');
    const assigned = await Promise.all((['FIRE', 'MEDICAL', 'POLICE', 'DRRMO'] as const).map(dept => actor(false, dept)));
    const dispatcher = await actor(false, 'FIRE', 'DISPATCHER');
    const report = await prisma.incident.create({ data: {
      title: 'Synthetic shared review; no emergency', reportedBy: citizen.sub, typeId, locationId,
      severityLevel: 'MEDIUM', requestedServices: ['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'],
      status: 'RESPONDING', verificationStatus: 'VERIFIED',
      serviceResponses: { create: (['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const).map(service => ({ service, status: 'RESPONDING' })) },
    } });
    const cookie = (user: JwtPayload) => `accessToken=${signAccessToken(user.sub, user.role, '15m', user.sessionId!)}`;
    const read = (user: JwtPayload) => request(app).get(`/api/incidents/v1/${report.incidentId}`).set('Cookie', cookie(user));
    const events: EmergencyEvent[] = [];
    const off = subscribeEmergencyEvents(event => { if (event.entityId === report.incidentId) events.push(event); });
    const before = await prisma.incident.findUniqueOrThrow({ where: { incidentId: report.incidentId }, include: { serviceResponses: true } });
    try {
      expect((await FlagIncidentService(report.incidentId, notes, assigned[3])).code).toBe(200);
      for (const user of [...assigned, dispatcher]) {
        const detail = await read(user);
        expect(detail.status).toBe(200);
        expect(detail.body.data.incident.reviewNotices).toMatchObject([{ department: 'DRRMO', status: 'PENDING', reason: notes }]);
        expect(detail.body.data.incident.reviewFlags?.length ?? 0).toBe(user.department === 'DRRMO' ? 1 : 0);
        for (const notice of detail.body.data.incident.reviewNotices) {
          expect(notice).not.toHaveProperty('flaggedBy'); expect(notice).not.toHaveProperty('reviewedBy');
        }
        const list = await request(app).get('/api/incidents/v1/?includeReviewFlags=true&department=MAIN&limit=100').set('Cookie', cookie(user));
        expect(list.status).toBe(200);
        expect(list.body.data.incidents.find((row: { incidentId: string }) => row.incidentId === report.incidentId).reviewNotices).toHaveLength(1);
      }
      let flag = await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { incidentId_department: { incidentId: report.incidentId, department: 'DRRMO' } } });
      const input = { status: 'CONFIRMED' as const, reviewNotes: notes, expectedUpdatedAt: flag.updatedAt.toISOString() };
      const deniedReview = await request(app).patch(`/api/incidents/v1/${report.incidentId}/review-flags/${flag.reviewFlagId}`).set('Origin', 'http://localhost:3000').set('Cookie', cookie(assigned[0])).send(input);
      expect(deniedReview.status).toBe(403);
      expect(deniedReview.body.message).toMatch(/main administrator/i);
      expect((await ReviewIncidentFlagService(report.incidentId, flag.reviewFlagId, input, main)).code).toBe(200);
      for (const user of assigned) expect((await read(user)).body.data.incident.reviewNotices).toMatchObject([{ status: 'CONFIRMED', reviewNotes: notes }]);
      flag = await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { reviewFlagId: flag.reviewFlagId } });
      const correction = { reviewNotes: 'Synthetic on-site investigation corrected the mistaken decision.', expectedUpdatedAt: flag.updatedAt.toISOString() };
      const deniedCorrection = await request(app).post(`/api/incidents/v1/${report.incidentId}/review-flags/${flag.reviewFlagId}/correction`).set('Origin', 'http://localhost:3000').set('Cookie', cookie(assigned[0])).send(correction);
      expect(deniedCorrection.status).toBe(403);
      expect(deniedCorrection.body.message).toMatch(/main administrator/i);
      expect((await CorrectIncidentFlagService(report.incidentId, flag.reviewFlagId, correction, main)).code).toBe(200);
      for (const user of assigned) {
        const data = (await read(user)).body.data.incident;
        expect(data.reviewNotices).toMatchObject([{ status: 'DISMISSED', reviewNotes: correction.reviewNotes }]);
        expect(data.reviewFlags).toEqual([]);
      }
      const privateRead = await read(citizen);
      expect(privateRead.status).toBe(200);
      expect(privateRead.body.data.incident).not.toHaveProperty('reviewNotices');
      expect(privateRead.body.data.incident).not.toHaveProperty('reviewFlags');
      const privateList = await request(app).get(`/api/incidents/v1/?includeReviewFlags=true&reportedBy=${randomUUID()}&department=MAIN`).set('Cookie', cookie(citizen));
      expect(privateList.status).toBe(200);
      expect(privateList.body.data.incidents).toHaveLength(1);
      expect(privateList.body.data.incidents[0]).not.toHaveProperty('reviewNotices');
      const unrelated = await incident(assigned[0]);
      await prisma.incidentReviewFlag.create({ data: { incidentId: unrelated.incidentId, department: 'MAIN', flaggedBy: main.sub, reason: 'Synthetic private unassigned review reason.' } });
      expect((await request(app).get(`/api/incidents/v1/${unrelated.incidentId}`).set('Cookie', cookie(assigned[1]))).status).toBe(403);
      const excluded = await request(app).get('/api/incidents/v1/?includeReviewFlags=true&department=MAIN&limit=100').set('Cookie', cookie(assigned[1]));
      expect(excluded.status).toBe(200);
      expect(excluded.body.data.incidents.some((row: { incidentId: string }) => row.incidentId === unrelated.incidentId)).toBe(false);
      expect(JSON.stringify(excluded.body)).not.toContain('private unassigned review reason');
      const after = await prisma.incident.findUniqueOrThrow({ where: { incidentId: report.incidentId }, include: { serviceResponses: true } });
      expect(after).toEqual(before);
      expect(await prisma.notificationOutbox.count()).toBe(0);
      expect(await prisma.assetCleanupJob.count()).toBe(0);
      expect(events).toHaveLength(3);
      for (const event of events) expect(Object.keys(event).sort()).toEqual(['type', 'entityId', 'occurredAt'].sort());
    } finally { off(); }
  }, 30000);
});
