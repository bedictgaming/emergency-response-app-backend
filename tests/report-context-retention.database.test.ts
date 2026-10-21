// Opt-in real PostgreSQL, synthetic only. No running workers or provider sends.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import type { Prisma } from '@/generated/prisma';
import type { JwtPayload } from '@/lib/jwt';
import { recentReportRequestContexts, REPORT_CONTEXT_RETENTION_MS, storeReportRequestContext } from '@/lib/report-request-context';
import { expireReportContextBatch, previewReportContextExpiry, previewLegacyReportContext, processExpiredReportContexts, REPORT_CONTEXT_BATCH_SIZE } from '@/lib/report-context-retention';
import { UserViolationSummary } from '@/services/user/account-safety-service';

const enabled = process.env.RUN_NATIVE_CONTEXT_RETENTION === '1';
const users: string[] = [], receipts: string[] = [], incidents: string[] = [], locations: string[] = [], types: string[] = [], jobs: string[] = [];
let confirmedTarget = false;
async function actor(department: 'MAIN' | 'FIRE' | null = null): Promise<JwtPayload> {
  const id = randomUUID(); users.push(id);
  await prisma.user.create({ data: { id, name: 'Synthetic privacy test', role: department ? 'ADMIN' : 'USER', department, isMainAdmin: department === 'MAIN' } });
  const token = await prisma.token.create({ data: { userId: id, type: 'REFRESH', token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { sub: id, type: 'access', sessionId: token.id, role: department ? 'ADMIN' : 'USER', department, isMainAdmin: department === 'MAIN' };
}
async function receipt(tx: Prisma.TransactionClient, owner: string, capturedAt: Date = new Date()) {
  const auditLogId = randomUUID(); receipts.push(auditLogId);
  return tx.auditLog.create({ data: { auditLogId, actorId: owner, action: 'INCIDENT_CREATED', entityType: 'Incident', entityId: randomUUID(),
    createdAt: capturedAt, metadata: { submissionKey: randomUUID(), nearbyReportDetected: false } }, select: { auditLogId: true, createdAt: true } });
}
async function capture(owner: string, capturedAt: Date = new Date()) {
  return prisma.$transaction(async tx => {
    const row = await receipt(tx, owner, capturedAt);
    if (capturedAt.getTime() < Date.now() - 60_000) {
      // Deliberately aged synthetic storage fixture, not a caller-controlled
      // capture timestamp or a production path for extending/changing expiry.
      await tx.reportRequestContext.create({ data: { auditLogId: row.auditLogId, capturedAt,
        expiresAt: new Date(capturedAt.getTime() + REPORT_CONTEXT_RETENTION_MS), ipAddress: '192.0.2.1', userAgent: 'SyntheticBrowser' } });
    } else await storeReportRequestContext(tx, row, { ipAddress: '192.0.2.1', userAgent: 'Synthetic\nBrowser' });
    return row;
  });
}
const expiredTime = () => new Date(Date.now() - REPORT_CONTEXT_RETENTION_MS - 60_000);

// The installed adapter's timestamptz decoder discards non-UTC offsets. Verify
// the real stored instant via UTC projection AND an independent PostgreSQL epoch;
// do not relax clock assertions or modify the application's global adapter.
async function storedInstant(tx: Prisma.TransactionClient, id: string) {
  const [row] = await tx.$queryRaw<Array<{ capturedAt: Date; expiresAt: Date; capturedMs: number; expiresMs: number }>>`
    SELECT captured_at AT TIME ZONE 'UTC' AS "capturedAt", expires_at AT TIME ZONE 'UTC' AS "expiresAt",
      (extract(epoch FROM captured_at)*1000)::float8 AS "capturedMs",
      (extract(epoch FROM expires_at)*1000)::float8 AS "expiresMs"
    FROM report_request_contexts WHERE audit_log_id=${id}::uuid
  `;
  expect(row.capturedAt.getTime()).toBe(row.capturedMs);
  expect(row.expiresAt.getTime()).toBe(row.expiresMs);
  return row;
}

describe.runIf(enabled)('native separate report-context expiry and ledger preservation', () => {
  beforeAll(async () => {
    const supplied = process.env.DISPOSABLE_DATABASE_URL, url = new URL(supplied || '');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/alert_disposable'
      || process.env.DATABASE_URL !== supplied || process.env.DIRECT_URL !== supplied || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
      || ENV.NODE_ENV !== 'test' || !ENV.REPORT_REQUEST_CONTEXT_ENABLED || ENV.BACKGROUND_JOBS_ENABLED || ENV.API_GATEWAY_REQUIRED
      || ENV.CLOUDINARY.API_SECRET || ENV.WEB_PUSH_PRIVATE_KEY || ENV.SMTP.PASS || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED)
      throw Error('ISOLATED_NATIVE_CONTEXT_TARGET_REQUIRED');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`)[0].name).toBe('alert_disposable');
    expect(await prisma.reportRequestContext.count()).toBe(0);
    confirmedTarget = true;
  });
  afterEach(async () => {
    if (!confirmedTarget) return;
    await prisma.reportRequestContext.deleteMany({ where: { auditLogId: { in: receipts } } });
    await prisma.auditLog.deleteMany({ where: { auditLogId: { in: receipts } } });
    await prisma.notificationOutbox.deleteMany({ where: { notificationOutboxId: { in: jobs } } });
    await prisma.attachment.deleteMany({ where: { incidentId: { in: incidents } } });
    await prisma.incident.deleteMany({ where: { incidentId: { in: incidents } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.location.deleteMany({ where: { locationId: { in: locations } } });
    await prisma.incidentType.deleteMany({ where: { typeId: { in: types } } });
    for (const ids of [users, receipts, incidents, locations, types, jobs]) ids.length = 0;
  });
  afterAll(() => prisma.$disconnect());

  it('atomically stores minimized context outside the immutable receipt and rolls back both together', async () => {
    const owner = await actor(), beforeCapture = Date.now(), row = await capture(owner.sub);
    const context = await prisma.reportRequestContext.findUniqueOrThrow({ where: { auditLogId: row.auditLogId } });
    const instant = await storedInstant(prisma, row.auditLogId);
    expect(instant.capturedMs).toBeGreaterThanOrEqual(beforeCapture - 10);
    expect(instant.capturedMs).toBeLessThanOrEqual(Date.now() + 10);
    expect(instant.expiresMs - instant.capturedMs).toBe(REPORT_CONTEXT_RETENTION_MS);
    expect(context.ipAddress).toBe('192.0.2.1'); expect(context.userAgent).toBe('SyntheticBrowser');
    const audit = await prisma.auditLog.findUniqueOrThrow({ where: { auditLogId: row.auditLogId } });
    expect(audit.ipAddress).toBeNull(); expect(audit.metadata).not.toHaveProperty('userAgent');
    await expect(prisma.$transaction(async tx => {
      const aborted = await receipt(tx, owner.sub); await storeReportRequestContext(tx, aborted, { userAgent: 'Synthetic rolled back' });
      throw Error('SYNTHETIC_ROLLBACK');
    })).rejects.toThrow('SYNTHETIC_ROLLBACK');
    expect(await prisma.auditLog.count({ where: { actorId: owner.sub } })).toBe(1);
    expect(await prisma.reportRequestContext.count()).toBe(1);
  });
  it('keeps capture/deadline correct under non-UTC and DST timezone sessions without changing audit history', async () => {
    const owner = await actor();
    for (const zone of ['Asia/Kuala_Lumpur', 'America/New_York']) {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`;
        const row = await receipt(tx, owner.sub, new Date('2020-01-01T00:00:00Z'));
        const before = await tx.auditLog.findUniqueOrThrow({ where: { auditLogId: row.auditLogId } });
        const instant = Date.now(); await storeReportRequestContext(tx, row, { userAgent: 'Synthetic timezone test' });
        const stored = await storedInstant(tx, row.auditLogId);
        expect(stored.capturedAt.getTime()).toBeGreaterThanOrEqual(instant - 10);
        expect(stored.capturedAt.getTime()).toBeLessThanOrEqual(Date.now() + 10);
        expect(stored.expiresAt.getTime() - stored.capturedAt.getTime()).toBe(REPORT_CONTEXT_RETENTION_MS);
        expect(await tx.auditLog.findUniqueOrThrow({ where: { auditLogId: row.auditLogId } })).toEqual(before);
      });
    }
  });
  it('enforces a fixed 30-day lifetime and prevents deleting a referenced receipt', async () => {
    const owner = await actor(), row = await capture(owner.sub);
    const stored = await storedInstant(prisma, row.auditLogId);
    await expect(prisma.reportRequestContext.update({ where: { auditLogId: row.auditLogId }, data: { expiresAt: new Date(stored.expiresAt.getTime() + 1) } })).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { auditLogId: row.auditLogId } })).rejects.toThrow();
    expect(await prisma.auditLog.count({ where: { auditLogId: row.auditLogId } })).toBe(1);
  });
  it('withholds expired context before cleanup, including after restore; access never extends expiry', async () => {
    const owner = await actor(), old = await capture(owner.sub, expiredTime()), active = await capture(owner.sub);
    const before = await prisma.reportRequestContext.findUniqueOrThrow({ where: { auditLogId: active.auditLogId } });
    const read = await prisma.$transaction(tx => recentReportRequestContexts(tx, [old.auditLogId, active.auditLogId]));
    expect(read.has(old.auditLogId)).toBe(false); expect(read.get(active.auditLogId)?.userAgent).toBe('SyntheticBrowser');
    expect(await prisma.reportRequestContext.findUnique({ where: { auditLogId: old.auditLogId } })).not.toBeNull();
    expect(await prisma.reportRequestContext.findUniqueOrThrow({ where: { auditLogId: active.auditLogId } })).toEqual(before);
  });
  it('treats the exact database-time expiry boundary as expired and leaves newer context intact', async () => {
    const owner = await actor(), boundary = await receipt(prisma, owner.sub), active = await capture(owner.sub);
    await prisma.$executeRaw`
      INSERT INTO report_request_contexts(audit_log_id, captured_at, expires_at, user_agent)
      VALUES (${boundary.auditLogId}::uuid, statement_timestamp()::timestamp(3) - INTERVAL '30 days', statement_timestamp()::timestamp(3), 'Synthetic boundary')
    `;
    const preview = await prisma.$transaction(tx => previewReportContextExpiry(tx)); expect(preview.expired).toBe(1);
    const read = await prisma.$transaction(tx => recentReportRequestContexts(tx, [boundary.auditLogId, active.auditLogId]));
    expect(read.has(boundary.auditLogId)).toBe(false); expect(read.has(active.auditLogId)).toBe(true);
    expect(await prisma.$transaction(tx => expireReportContextBatch(tx))).toEqual({ deleted: 1 });
    expect(await prisma.reportRequestContext.findUnique({ where: { auditLogId: active.auditLogId } })).not.toBeNull();
  });
  it('keeps Main-only access and never resurrects legacy audit context as a fallback', async () => {
    const owner = await actor(), main = await actor('MAIN'), fire = await actor('FIRE');
    const active = await capture(owner.sub), old = await capture(owner.sub, expiredTime()), legacy = await receipt(prisma, owner.sub, expiredTime());
    await prisma.auditLog.update({ where: { auditLogId: legacy.auditLogId }, data: { ipAddress: '198.51.100.123', metadata: { userAgent: 'Synthetic legacy raw context' } } });
    expect(await prisma.$transaction(tx => previewLegacyReportContext(tx))).toEqual([{ action: 'INCIDENT_CREATED', records: 1, overThirtyDays: 1 }]);
    expect((await UserViolationSummary(owner.sub, fire)).code).toBe(403);
    const summary = await UserViolationSummary(owner.sub, main); expect(summary.code).toBe(200);
    const reports = summary.data!.recentReports;
    expect(reports.filter(item => item.ipAddress !== null)).toHaveLength(1);
    expect(JSON.stringify(reports)).not.toMatch(/198\.51\.100\.123|Synthetic legacy raw context/);
    expect((await prisma.$transaction(tx => recentReportRequestContexts(tx, [old.auditLogId]))).size).toBe(0);
    await prisma.token.update({ where: { id: main.sessionId }, data: { revokedAt: new Date() } });
    expect((await UserViolationSummary(owner.sub, main)).code).toBe(403);
    expect(await prisma.reportRequestContext.findUnique({ where: { auditLogId: active.auditLogId } })).not.toBeNull();
  });
  it('bounds large cleanup to 250 rows, retries safely and never removes receipts', async () => {
    const owner = await actor(), capturedAt = expiredTime(), count = REPORT_CONTEXT_BATCH_SIZE + 7;
    const data = Array.from({ length: count }, () => ({ auditLogId: randomUUID(), actorId: owner.sub, action: 'INCIDENT_CREATED', entityType: 'Incident', createdAt: capturedAt }));
    receipts.push(...data.map(row => row.auditLogId));
    await prisma.auditLog.createMany({ data });
    await prisma.reportRequestContext.createMany({ data: data.map(row => ({ auditLogId: row.auditLogId, capturedAt, expiresAt: new Date(capturedAt.getTime() + REPORT_CONTEXT_RETENTION_MS), userAgent: 'Synthetic batch' })) });
    expect((await prisma.$transaction(tx => previewReportContextExpiry(tx))).expired).toBe(count);
    expect(await prisma.$transaction(tx => expireReportContextBatch(tx))).toEqual({ deleted: REPORT_CONTEXT_BATCH_SIZE });
    expect(await prisma.$transaction(tx => expireReportContextBatch(tx))).toEqual({ deleted: 7 });
    expect(await prisma.$transaction(tx => expireReportContextBatch(tx))).toEqual({ deleted: 0 });
    expect(await prisma.auditLog.count({ where: { actorId: owner.sub } })).toBe(count);
  });
  it('skips a concurrently locked row and disposes it on the next safe retry', async () => {
    const owner = await actor(), locked = await capture(owner.sub, expiredTime()); await capture(owner.sub, expiredTime());
    let unlock!: () => void, signal!: () => void;
    const ready = new Promise<void>(resolve => { signal = resolve; }), release = new Promise<void>(resolve => { unlock = resolve; });
    const lock = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT audit_log_id FROM report_request_contexts WHERE audit_log_id=${locked.auditLogId}::uuid FOR UPDATE`;
      signal(); await release;
    });
    try { await ready; expect(await prisma.$transaction(tx => expireReportContextBatch(tx))).toEqual({ deleted: 1 }); }
    finally { unlock(); await lock; }
    expect(await prisma.$transaction(tx => expireReportContextBatch(tx))).toEqual({ deleted: 1 });
  });
  it('rolls back a failed disposal transaction and supports concurrent batches without double disposal', async () => {
    const owner = await actor(); await capture(owner.sub, expiredTime()); await capture(owner.sub, expiredTime());
    await expect(prisma.$transaction(async tx => { await expireReportContextBatch(tx); throw Error('SYNTHETIC_DISPOSAL_ROLLBACK'); })).rejects.toThrow('SYNTHETIC_DISPOSAL_ROLLBACK');
    expect(await prisma.reportRequestContext.count()).toBe(2);
    const results = await Promise.all([prisma.$transaction(tx => expireReportContextBatch(tx)), prisma.$transaction(tx => expireReportContextBatch(tx))]);
    expect(results.reduce((total, item) => total + item.deleted, 0)).toBe(2);
    expect(await prisma.auditLog.count({ where: { actorId: owner.sub } })).toBe(2);
  });
  it('preserves report/photo/outbox, quota receipts, legacy fields, decision count, account and session', async () => {
    const owner = await actor(), main = await actor('MAIN'); await capture(owner.sub, expiredTime());
    const type = await prisma.incidentType.create({ data: { typeName: `Synthetic privacy ${randomUUID()}` } }); types.push(type.typeId);
    const location = await prisma.location.create({ data: { locationName: 'Synthetic privacy location' } }); locations.push(location.locationId);
    const incident = await prisma.incident.create({ data: { reportedBy: owner.sub, typeId: type.typeId, locationId: location.locationId,
      title: 'Synthetic retained report', severityLevel: 'MEDIUM', requestedServices: ['FIRE'], verificationStatus: 'VERIFIED',
      attachments: { create: { fileName: 'synthetic.jpg', fileType: 'image/jpg', fileUrl: 'https://evidence.invalid/retained.jpg', uploadedBy: owner.sub } } } }); incidents.push(incident.incidentId);
    const job = await prisma.notificationOutbox.create({ data: { eventType: 'INCIDENT_CREATED', payload: { syntheticOnly: true }, userIds: [main.sub], audienceIds: [main.sub] } }); jobs.push(job.notificationOutboxId);
    for (const data of [
      { action: 'PHOTO_UPLOAD_ATTEMPT', entityType: 'EvidenceUpload', entityId: null, metadata: { quota: 'retained' }, ipAddress: '192.0.2.22' },
      { action: 'CITIZEN_FALSE_REPORT_DECISION', entityType: 'User', entityId: owner.sub, metadata: { incidentId: incident.incidentId, cycleId: 'initial', confirmed: true, version: 1 }, ipAddress: null },
    ]) { const row = await prisma.auditLog.create({ data: { ...data, actorId: owner.sub, createdAt: expiredTime() } }); receipts.push(row.auditLogId); }
    const before = await prisma.auditLog.findMany({ where: { auditLogId: { in: receipts } }, orderBy: { auditLogId: 'asc' } });
    const reportBefore = await prisma.incident.findUniqueOrThrow({ where: { incidentId: incident.incidentId }, include: { attachments: true } });
    expect((await UserViolationSummary(owner.sub, main)).data!.confirmedFalseCount).toBe(1);
    expect(await prisma.$transaction(tx => expireReportContextBatch(tx))).toEqual({ deleted: 1 });
    expect(await prisma.auditLog.findMany({ where: { auditLogId: { in: receipts } }, orderBy: { auditLogId: 'asc' } })).toEqual(before);
    expect(await prisma.incident.findUniqueOrThrow({ where: { incidentId: incident.incidentId }, include: { attachments: true } })).toEqual(reportBefore);
    expect(await prisma.notificationOutbox.findUniqueOrThrow({ where: { notificationOutboxId: job.notificationOutboxId } })).toEqual(job);
    expect((await UserViolationSummary(owner.sub, main)).data!.confirmedFalseCount).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.sub } })).status).toBe('ACTIVE');
    expect((await prisma.token.findUniqueOrThrow({ where: { id: owner.sessionId } })).revokedAt).toBeNull();
  });
  it('does not launch automatic disposal with workers disabled, even when capture is tested', async () => {
    const owner = await actor(); await capture(owner.sub, expiredTime());
    expect(await processExpiredReportContexts()).toEqual({ status: 'disabled' });
    expect(await prisma.reportRequestContext.count()).toBe(1);
  });
});
