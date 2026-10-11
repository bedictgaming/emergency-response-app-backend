// Native two-connection regression. Only the empty loopback native gate may enable this suite.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
vi.mock('@/lib/cloudinary', () => ({ verifyUploadedAsset: vi.fn(() => { throw new Error('No provider proof permitted in native authority fixture'); }) }));
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { CreateIncidentService } from '@/services/incident/create-incident-service';

const run = process.env.RUN_NATIVE_INCIDENT_AUTHORITY_TESTS === '1';
const suite = describe.runIf(run);
const users: string[] = [];
let typeId: string, locationId: string, barangayId: string;
let confirmedTarget = false;

function guard() {
  const supplied = process.env.DISPOSABLE_DATABASE_URL || '';
  const url = new URL(supplied);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.pathname !== '/alert_disposable' || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
    || process.env.DATABASE_URL !== supplied || process.env.DIRECT_URL !== supplied
    || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED
    || ENV.API_GATEWAY_REQUIRED || ENV.CLOUDINARY.API_SECRET || ENV.WEB_PUSH_PRIVATE_KEY || ENV.SMTP.PASS) {
    throw new Error('NATIVE_AUTHORITY_ISOLATED_TARGET_REQUIRED');
  }
}
suite('native incident authority serialization', () => {
  beforeAll(async () => {
    guard();
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0].name).toBe('alert_disposable');
    confirmedTarget = true;
    typeId = (await prisma.incidentType.create({ data: { typeName: `Fire synthetic authority ${randomUUID()}` } })).typeId;
    locationId = (await prisma.location.create({ data: { locationName: 'Synthetic authority fixture; no emergency' } })).locationId;
    barangayId = (await prisma.barangay.create({ data: { name: `Synthetic authority ${randomUUID()}` } })).barangayId;
  });
  afterAll(async () => {
    if (!confirmedTarget) { await prisma.$disconnect(); return; }
    // These are only fixture-owned IDs; no broad or production cleanup.
    await prisma.notificationOutbox.deleteMany({ where: { audienceIds: { hasSome: users } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await prisma.incident.deleteMany({ where: { reportedBy: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    if (barangayId) await prisma.barangay.delete({ where: { barangayId } });
    if (locationId) await prisma.location.delete({ where: { locationId } });
    if (typeId) await prisma.incidentType.delete({ where: { typeId } });
    await prisma.$disconnect();
  });
  it.each([
    { role: 'USER', status: 'ACTIVE', department: null, expected: 409 },
    { role: 'ADMIN', status: 'INACTIVE', department: 'FIRE', expected: 403 },
    { role: 'ADMIN', status: 'ACTIVE', department: 'MEDICAL', expected: 409 },
  ])('rereads committed account changes after waiting for the reporter lock: %j', async next => {
    const actorId = randomUUID(); users.push(actorId);
    await prisma.user.create({ data: { id: actorId, name: 'Synthetic native authority', role: 'ADMIN', department: 'FIRE', isMainAdmin: false } });
    const mutation = new pg.Client({ connectionString: process.env.DISPOSABLE_DATABASE_URL, connectionTimeoutMillis: 5000 });
    let pending: ReturnType<typeof CreateIncidentService> | undefined;
    try {
      await mutation.connect();
      const pid = Number((await mutation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await mutation.query('BEGIN');
      await mutation.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [actorId]);
      await mutation.query('UPDATE "User" SET role=$2::"Role", status=$3::"UserStatus", department=$4::"Department", "updatedAt"=now() WHERE id=$1', [actorId, next.role, next.status, next.department]);
      // The nonlocking preflight sees the old committed FIRE assignment, then
      // its transaction blocks behind the native account-administration lock.
      pending = CreateIncidentService({ title: 'Synthetic native authority race', typeId, locationId, barangayId,
        duplicateOverrideReason: 'Synthetic race only' }, actorId);
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (!waiting && Date.now() < deadline) {
        waiting = Boolean((await mutation.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting);
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      await mutation.query('COMMIT');
      expect((await pending).code).toBe(next.expected);
      expect(await prisma.incident.count({ where: { reportedBy: actorId } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { actorId } })).toBe(0);
      expect(await prisma.notificationOutbox.count({ where: { audienceIds: { has: actorId } } })).toBe(0);
    } finally {
      await mutation.query('ROLLBACK').catch(() => undefined);
      await pending?.catch(() => undefined);
      await mutation.end().catch(() => undefined);
    }
  }, 15000);
});
