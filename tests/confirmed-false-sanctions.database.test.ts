import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
const mail = vi.hoisted(() => vi.fn(async (_message: unknown) => undefined));
vi.mock('@/services/mail/mailer', () => ({ sendEmail: mail }));
import request from 'supertest';
import app from '@/app';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { signAccessToken, type JwtPayload } from '@/lib/jwt';
import { FlagIncidentService, ReviewIncidentFlagService, CorrectIncidentFlagService } from '@/services/incident/review-incident-service';
import { DecideNearbyReview } from '@/services/incident/nearby-review-service';
import { UpdateUserStatusService } from '@/services/user/update-user-status-service';
import { AdminRequestPasswordReset, UserViolationSummary } from '@/services/user/account-safety-service';
import { reportRequestContext } from '@/lib/report-request-context';
import { NearbyDetectionService } from '@/services/incident/nearby-detection-service';
import type { Department, ResponseService } from '@/generated/prisma';

const enabled = process.env.RUN_NATIVE_FALSE_SANCTIONS === '1';
const users: string[] = [];
let typeId: string, locationId: string, confirmedTarget = false;
const notes = 'Synthetic investigation confirmed this was not a genuine emergency.';
async function actor(department: Department | null = null): Promise<JwtPayload> {
  const id = randomUUID(); users.push(id);
  await prisma.user.create({ data: { id, email: `${id}@example.invalid`, name: 'Synthetic sanctions', role: department ? 'ADMIN' : 'USER', department, isMainAdmin: department === 'MAIN' } });
  const session = await prisma.token.create({ data: { userId: id, type: 'REFRESH', token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { sub: id, type: 'access', sessionId: session.id, role: department ? 'ADMIN' : 'USER', department, isMainAdmin: department === 'MAIN' };
}
async function report(owner: JwtPayload, services: ResponseService[] = ['FIRE']) {
  return prisma.incident.create({ data: { title: 'Synthetic sanction report; no emergency', reportedBy: owner.sub, typeId, locationId,
    latitude: 10.251, longitude: 123.949,
    status: 'RESPONDING', verificationStatus: 'VERIFIED', requestedServices: services, severityLevel: 'MEDIUM',
    serviceResponses: { create: services.map(service => ({ service, status: 'RESPONDING' })) } } });
}
async function flag(id: string, by: JwtPayload) {
  const response = await FlagIncidentService(id, notes, by); expect(response.code).toBe(200); return response.data!.flag;
}
async function confirm(id: string, value: Awaited<ReturnType<typeof flag>>, main: JwtPayload) {
  return ReviewIncidentFlagService(id, value.reviewFlagId, { status: 'CONFIRMED', reviewNotes: notes, expectedUpdatedAt: value.updatedAt.toISOString() }, main);
}
async function summary(user: JwtPayload, main: JwtPayload) { const result = await UserViolationSummary(user.sub, main); expect(result.code).toBe(200); return result.data!; }

describe.runIf(enabled)('native confirmed-false sanctions and owner-controlled recovery', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DISPOSABLE_DATABASE_URL || '');
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/alert_disposable'
      || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable' || process.env.DATABASE_URL !== process.env.DISPOSABLE_DATABASE_URL
      || process.env.DIRECT_URL !== process.env.DISPOSABLE_DATABASE_URL || process.env.CONFIRMED_FALSE_SANCTIONS_ENABLED !== 'true'
      || process.env.NEARBY_REVIEW_ENABLED !== 'true' || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED
      || ENV.API_GATEWAY_REQUIRED || ENV.CLOUDINARY.API_SECRET || ENV.WEB_PUSH_PRIVATE_KEY || ENV.SMTP.PASS
      || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED) throw Error('ISOLATED_NATIVE_SANCTION_TARGET_REQUIRED');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`)[0].name).toBe('alert_disposable');
    confirmedTarget = true;
    typeId = (await prisma.incidentType.create({ data: { typeName: `Synthetic Fire sanction ${randomUUID()}` } })).typeId;
    locationId = (await prisma.location.create({ data: { locationName: 'Synthetic sanction location' } })).locationId;
  });
  afterAll(async () => {
    if (confirmedTarget) {
      await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: users } }, { entityType: 'User', entityId: { in: users } }] } });
      await prisma.incidentNearbyReview.deleteMany({ where: { incident: { reportedBy: { in: users } } } });
      await prisma.incident.deleteMany({ where: { reportedBy: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.location.delete({ where: { locationId } }); await prisma.incidentType.delete({ where: { typeId } });
    }
    await prisma.$disconnect();
  });
  it('ignores pending flags, counts unique reports, deactivates at three and invalidates a real HTTP session', async () => {
    const citizen = await actor(), main = await actor('MAIN'), fire = await actor('FIRE');
    const reports = await Promise.all([report(citizen), report(citizen), report(citizen)]);
    const flags = await Promise.all(reports.map(item => flag(item.incidentId, fire)));
    expect((await summary(citizen, main)).confirmedFalseCount).toBe(0);
    for (let i = 0; i < reports.length; i++) { expect((await confirm(reports[i].incidentId, flags[i], main)).code).toBe(200);
      expect((await summary(citizen, main)).confirmedFalseCount).toBe(i + 1); }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: citizen.sub } })).status).toBe('INACTIVE');
    expect(await prisma.token.count({ where: { userId: citizen.sub, revokedAt: null } })).toBe(0);
    const cookie = `accessToken=${signAccessToken(citizen.sub, 'USER', '15m', citizen.sessionId)}`;
    const denied = await request(app).get('/api/incidents/v1/').set('Cookie', cookie);
    expect(denied.status).toBe(403); expect(denied.body.message).toMatch(/inactive/i);
    expect(await prisma.incident.count({ where: { reportedBy: citizen.sub } })).toBe(3);
    expect((await UserViolationSummary(citizen.sub, fire)).code).toBe(403);
  });
  it('never double counts one shared report reviewed by two departments', async () => {
    const citizen = await actor(), main = await actor('MAIN'), fire = await actor('FIRE'), medical = await actor('MEDICAL');
    const item = await report(citizen, ['FIRE', 'MEDICAL']);
    const f = await flag(item.incidentId, fire), m = await flag(item.incidentId, medical);
    expect((await confirm(item.incidentId, f, main)).code).toBe(200); expect((await confirm(item.incidentId, m, main)).code).toBe(200);
    expect((await summary(citizen, main)).confirmedFalseCount).toBe(1);
    expect((await confirm(item.incidentId, f, main)).code).toBe(409);
  });
  it('serializes two administrators confirming different reports without lost strikes or duplicate deactivation', async () => {
    const citizen = await actor(), main = await actor('MAIN'), second = await actor('MAIN'), fire = await actor('FIRE');
    const items = await Promise.all([report(citizen), report(citizen), report(citizen)]);
    const flags = await Promise.all(items.map(item => flag(item.incidentId, fire)));
    expect((await confirm(items[0].incidentId, flags[0], main)).code).toBe(200);
    expect((await Promise.all([confirm(items[1].incidentId, flags[1], main), confirm(items[2].incidentId, flags[2], second)])).map(row => row.code)).toEqual([200, 200]);
    expect((await summary(citizen, main)).confirmedFalseCount).toBe(3);
    expect(await prisma.auditLog.count({ where: { entityId: citizen.sub, action: 'CITIZEN_AUTO_DEACTIVATED' } })).toBe(1);
  });
  it('corrects counts without restoring access, allows only Main reactivation and never recounts old-cycle reports', async () => {
    const citizen = await actor(), main = await actor('MAIN'), fire = await actor('FIRE');
    const items = await Promise.all([report(citizen), report(citizen), report(citizen)]);
    for (const item of items) expect((await confirm(item.incidentId, await flag(item.incidentId, fire), main)).code).toBe(200);
    const current = await prisma.incidentReviewFlag.findFirstOrThrow({ where: { incidentId: items[0].incidentId } });
    expect((await CorrectIncidentFlagService(items[0].incidentId, current.reviewFlagId, { reviewNotes: 'Synthetic correction after additional evidence was reviewed.', expectedUpdatedAt: current.updatedAt.toISOString() }, main)).code).toBe(200);
    expect((await summary(citizen, main)).confirmedFalseCount).toBe(2);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: citizen.sub } })).status).toBe('INACTIVE');
    expect((await UpdateUserStatusService(citizen.sub, 'ACTIVE', fire.sub)).code).toBe(403);
    expect((await UpdateUserStatusService(citizen.sub, 'ACTIVE', main.sub)).code).toBe(200);
    expect((await summary(citizen, main)).confirmedFalseCount).toBe(0);
    expect((await confirm(items[0].incidentId, await flag(items[0].incidentId, fire), main)).code).toBe(200);
    expect((await summary(citizen, main)).confirmedFalseCount).toBe(0);
    const fresh = await report(citizen); expect((await confirm(fresh.incidentId, await flag(fresh.incidentId, fire), main)).code).toBe(200);
    expect((await summary(citizen, main)).confirmedFalseCount).toBe(1);
  });
  it('requires all requested nearby lanes to reject; a genuine accepted lane prevents the strike', async () => {
    const citizen = await actor(), main = await actor('MAIN'), fire = await actor('FIRE'), medical = await actor('MEDICAL');
    const parent = await report(await actor(), ['FIRE', 'MEDICAL']);
    for (const accepted of [false, true]) {
      const item = await report(citizen, ['FIRE', 'MEDICAL']);
      for (const service of ['FIRE', 'MEDICAL'] as const) await prisma.incidentNearbyReview.create({ data: { incidentId: item.incidentId, parentIncidentId: parent.incidentId, service } });
      const f = await prisma.incidentNearbyReview.findUniqueOrThrow({ where: { incidentId_service: { incidentId: item.incidentId, service: 'FIRE' } } });
      const m = await prisma.incidentNearbyReview.findUniqueOrThrow({ where: { incidentId_service: { incidentId: item.incidentId, service: 'MEDICAL' } } });
      expect((await DecideNearbyReview(f.reviewId, { status: 'REJECTED', version: 1, reason: notes }, fire)).code).toBe(200);
      expect((await summary(citizen, main)).confirmedFalseCount).toBe(accepted ? 1 : 0);
      expect((await DecideNearbyReview(m.reviewId, { status: accepted ? 'ACKNOWLEDGED' : 'REJECTED', version: 1, reason: accepted ? undefined : notes }, medical)).code).toBe(200);
      expect((await summary(citizen, main)).confirmedFalseCount).toBe(1);
      expect((await DecideNearbyReview(f.reviewId, { status: 'REJECTED', version: 1, reason: notes }, fire)).code).toBe(200);
    }
  });
  it('does not backfill previously confirmed flags or count staff-owned reports', async () => {
    const citizen = await actor(), main = await actor('MAIN');
    const historical = await report(citizen);
    await prisma.incidentReviewFlag.create({ data: { incidentId: historical.incidentId, department: 'MAIN', flaggedBy: main.sub, status: 'CONFIRMED', reason: notes } });
    expect((await summary(citizen, main)).confirmedFalseCount).toBe(0);
    const staffReport = await report(main); expect((await confirm(staffReport.incidentId, await flag(staffReport.incidentId, main), main)).code).toBe(200);
    expect((await summary(main, main)).confirmedFalseCount).toBe(0);
  });
  it('rejects a revoked actor before changing a flag or recording a strike', async () => {
    const citizen = await actor(), main = await actor('MAIN'), fire = await actor('FIRE'); const item = await report(citizen), f = await flag(item.incidentId, fire);
    await prisma.token.update({ where: { id: main.sessionId }, data: { revokedAt: new Date() } });
    expect((await confirm(item.incidentId, f, main)).code).toBe(403);
    expect((await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { reviewFlagId: f.reviewFlagId } })).status).toBe('PENDING');
    expect(await prisma.auditLog.count({ where: { entityId: citizen.sub, action: 'CITIZEN_FALSE_REPORT_DECISION' } })).toBe(0);
  });
  it('rolls back the third decision, deactivation, tokens and ledger together on transaction failure', async () => {
    const citizen = await actor(), main = await actor('MAIN'), fire = await actor('FIRE');
    for (let i = 0; i < 2; i++) { const item = await report(citizen); expect((await confirm(item.incidentId, await flag(item.incidentId, fire), main)).code).toBe(200); }
    const item = await report(citizen), f = await flag(item.incidentId, fire);
    const transaction = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (callback: (tx: unknown) => Promise<unknown>) => transaction(async tx => {
      await callback(tx); throw Error('Synthetic rollback after all sanction writes');
    })) as typeof prisma.$transaction);
    try { expect((await confirm(item.incidentId, f, main)).code).toBe(500); } finally { spy.mockRestore(); }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: citizen.sub } })).status).toBe('ACTIVE');
    expect((await prisma.incidentReviewFlag.findUniqueOrThrow({ where: { reviewFlagId: f.reviewFlagId } })).status).toBe('PENDING');
    expect(await prisma.token.count({ where: { userId: citizen.sub, revokedAt: null } })).toBe(1);
    expect((await summary(citizen, main)).confirmedFalseCount).toBe(2);
  });
  it('issues only a hashed owner-email reset, audits/rate-limits it, and never exposes a password or token', async () => {
    mail.mockClear(); const citizen = await actor(), main = await actor('MAIN'), fire = await actor('FIRE');
    expect((await AdminRequestPasswordReset(citizen.sub, fire)).code).toBe(403); expect(mail).not.toHaveBeenCalled();
    const result = await AdminRequestPasswordReset(citizen.sub, main); expect(result.code).toBe(202);
    const delivered = mail.mock.calls[0][0] as { to: string; accountAction: { url: string } };
    expect(delivered.to).toBe(`${citizen.sub}@example.invalid`);
    const token = new URL(delivered.accountAction.url).searchParams.get('resetToken')!;
    const stored = await prisma.token.findFirstOrThrow({ where: { userId: citizen.sub, type: 'PASSWORD_RESET' } });
    expect(stored.token).toBe(createHash('sha256').update(token).digest('hex')); expect(JSON.stringify(result)).not.toContain(token);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: citizen.sub } })).password).toBeNull();
    expect((await AdminRequestPasswordReset(citizen.sub, main)).code).toBe(429); expect(mail).toHaveBeenCalledTimes(1);
  });
  it('fails honestly on email delivery failure and does not reactivate inactive accounts', async () => {
    const citizen = await actor(), main = await actor('MAIN'); mail.mockRejectedValueOnce(Error('synthetic provider failure'));
    expect((await AdminRequestPasswordReset(citizen.sub, main)).code).toBe(503);
    await prisma.user.update({ where: { id: citizen.sub }, data: { status: 'INACTIVE' } });
    expect((await AdminRequestPasswordReset(citizen.sub, main)).code).toBe(409);
  });
  it('enforces actual HTTP Main-only scope and rejects forged reset recipients before issuing a link', async () => {
    const citizen = await actor(), main = await actor('MAIN'), fire = await actor('FIRE');
    const cookie = (user: JwtPayload) => `accessToken=${signAccessToken(user.sub, user.role, '15m', user.sessionId)}`;
    const path = `/api/users/v1/${citizen.sub}`;
    expect((await request(app).get(`${path}/violations`)).status).toBe(401);
    expect((await request(app).get(`${path}/violations`).set('Cookie', cookie(fire))).status).toBe(403);
    expect((await request(app).get(`${path}/violations`).set('Cookie', cookie(main))).status).toBe(200);
    expect((await request(app).post(`${path}/password-reset`).set('Cookie', cookie(main)).set('Origin', ENV.FRONTEND_URL).send({ email: 'forged@example.invalid' })).status).toBe(400);
    expect(await prisma.token.count({ where: { userId: citizen.sub, type: 'PASSWORD_RESET' } })).toBe(0);
    expect((await request(app).post(`${path}/password-reset`).set('Cookie', cookie(main)).set('Origin', ENV.FRONTEND_URL).send({})).status).toBe(202);
  });
  it('normalizes server-only request context without trusting control characters or creating an IMEI identity', () => {
    expect(reportRequestContext('invalid forwarded string', 'Chrome\r\nInjected')).toEqual({ ipAddress: undefined, userAgent: 'ChromeInjected' });
    expect(reportRequestContext('127.0.0.1', 'x'.repeat(1000)).userAgent).toHaveLength(384);
  });
  it('labels authorized pending flags on nearby pins without leaking pins or identities to citizens', async () => {
    const citizen = await actor(), fire = await actor('FIRE');
    const anchor = await report(citizen), peer = await report(await actor()); await flag(peer.incidentId, fire);
    const detected = await NearbyDetectionService({ kind: 'department', incidentId: anchor.incidentId }, fire);
    expect(detected.code).toBe(200);
    expect((detected.data as { items: Array<{ incidentId: string; flaggedForReview?: boolean }> }).items.find(item => item.incidentId === peer.incidentId)?.flaggedForReview).toBe(true);
    const privateResult = await NearbyDetectionService({ kind: 'citizen', latitude: 10.251, longitude: 123.949, services: ['FIRE'] }, citizen);
    expect(privateResult.code).toBe(200); expect(JSON.stringify(privateResult)).not.toContain(peer.incidentId);
    expect(JSON.stringify(privateResult)).not.toContain('flaggedForReview');
  });
});
