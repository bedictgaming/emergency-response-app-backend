// Synthetic-only native PostgreSQL gate; no hosted database or providers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import type { JwtPayload } from '@/lib/jwt';
import { FlagIncidentService, ReviewIncidentFlagService, CorrectIncidentFlagService } from '@/services/incident/review-incident-service';
import { DeleteIncidentService } from '@/services/incident/delete-incident-service';
import { UpdateServiceResponseService } from '@/services/incident/update-service-response-service';
import { AnalyticsRepository } from '@/repositories/analytics.repository';

const suite = describe.runIf(process.env.RUN_INCIDENT_REVIEW_HARDENING_TESTS === '1');
const users: string[] = [];
let typeId: string, locationId: string, confirmedTarget = false;
const notes = 'Synthetic investigation found this was not a genuine emergency.';

async function actor(main: boolean): Promise<JwtPayload> {
  const id = randomUUID(); users.push(id);
  await prisma.user.create({ data: { id, name: 'Synthetic review fixture', role: 'ADMIN', department: main ? 'MAIN' : 'FIRE', isMainAdmin: main } });
  const session = await prisma.token.create({ data: { userId: id, type: 'REFRESH', token: `synthetic-${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000) } });
  return { sub: id, sessionId: session.id, type: 'access', role: 'ADMIN', department: main ? 'MAIN' : 'FIRE', isMainAdmin: main };
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
      await prisma.incident.deleteMany({ where: { reportedBy: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      if (locationId) await prisma.location.delete({ where: { locationId } });
      if (typeId) await prisma.incidentType.delete({ where: { typeId } });
    }
    await prisma.$disconnect();
  });

  for (const action of ['flag', 'review', 'correct', 'delete', 'resolve']) {
    it.each(['inactive', 'demoted', 'transferred', 'session-revoked'])(`rejects ${action} after a competing %s commits before authority is locked`, async change => {
      const user = await actor(!['flag', 'resolve'].includes(action));
      const report = await incident(user, action === 'delete');
      const flag = await prisma.incidentReviewFlag.create({ data: { incidentId: report.incidentId, department: 'FIRE', flaggedBy: user.sub, reason: notes, status: action === 'correct' ? 'CONFIRMED' : 'PENDING' } });
      const input = { status: 'CONFIRMED' as const, reviewNotes: notes, expectedUpdatedAt: flag.updatedAt.toISOString() };
      const run = () => action === 'flag' ? FlagIncidentService(report.incidentId, notes, user)
        : action === 'review' ? ReviewIncidentFlagService(report.incidentId, flag.reviewFlagId, input, user)
        : action === 'correct' ? CorrectIncidentFlagService(report.incidentId, flag.reviewFlagId, input, user)
        : action === 'delete' ? DeleteIncidentService(report.incidentId, user, { reason: notes, confirmation: 'DELETE' })
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
        pending = run();
        let waiting = false;
        const deadline = Date.now() + 4000;
        while (!waiting && Date.now() < deadline) {
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
});
