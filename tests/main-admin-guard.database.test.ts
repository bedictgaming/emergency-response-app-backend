/** Opt-in, exact synthetic staging target only; no reports, mail, push or schema changes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { UpdateUserRoleService } from '@/services/user/update-user-role-service';
import { UpdateUserStatusService } from '@/services/user/update-user-status-service';
import type { Prisma } from '@/generated/prisma';

const run = process.env.RUN_MAIN_ADMIN_DATABASE_TESTS === '1';
const emails = ['a', 'b', 'citizen'].map(label => `main-guard-${randomUUID()}-${label}@example.invalid`);
let confirmedTarget = false;
let ids: string[] = [];
describe.runIf(run)('main administrator real PostgreSQL continuity', () => {
  beforeAll(async () => {
    const target = process.env.DISPOSABLE_DATABASE_URL;
    const name = target && new URL(target).pathname.slice(1);
    if (!target || process.env.DATABASE_URL !== target || process.env.CONFIRM_DISPOSABLE_DATABASE !== name
      || !/^emergency_staging_\d{8}_[a-f0-9]{6}$/.test(name!) || ENV.BACKGROUND_JOBS_ENABLED || ENV.API_GATEWAY_REQUIRED
      || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED) throw new Error('Explicit synthetic database and disabled workers required');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`)[0].name).toBe(name);
    confirmedTarget = true;
    for (const email of emails) {
      const user = await prisma.user.create({ data: { email, name: 'Synthetic MAIN guard test', role: 'USER', status: 'ACTIVE', emailVerified: new Date() } });
      ids.push(user.id);
    }
  }, 60000);
  beforeEach(async () => {
    await prisma.user.updateMany({ where: { id: { in: ids.slice(0, 2) }, email: { in: emails.slice(0, 2) } }, data: { role: 'ADMIN', status: 'ACTIVE', department: 'MAIN', isMainAdmin: true } });
    await prisma.user.update({ where: { id: ids[2] }, data: { role: 'USER', status: 'ACTIVE', department: null, isMainAdmin: false } });
  }, 30000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (confirmedTarget) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'User', entityId: { in: ids }, actorId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids }, email: { in: emails } } });
      expect(await prisma.user.count({ where: { email: { in: emails } } })).toBe(0);
    }
    await prisma.$disconnect();
  }, 30000);
  it('blocks the reported MAIN-to-FIRE self-lockout without a mutation or audit', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: ids[0] } });
    const audits = await prisma.auditLog.count({ where: { entityId: ids[0] } });
    expect((await UpdateUserRoleService(ids[0], 'ADMIN', ids[0], 'FIRE', false)).code).toBe(400);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after).toMatchObject({ role: 'ADMIN', status: 'ACTIVE', department: 'MAIN', isMainAdmin: true });
    expect(await prisma.auditLog.count({ where: { entityId: ids[0] } })).toBe(audits);
  }, 30000);
  it.each(['role', 'status'] as const)('serializes competing %s changes and denies the now-stale actor', async kind => {
    const change = (target: string, actor: string) => kind === 'role'
      ? UpdateUserRoleService(target, 'ADMIN', actor, 'FIRE', false)
      : UpdateUserStatusService(target, 'INACTIVE', actor);
    const results = await Promise.all([change(ids[0], ids[1]), change(ids[1], ids[0])]);
    expect(results.map(result => result.code).sort()).toEqual([200, 403]);
    expect(await prisma.user.count({ where: { id: { in: ids.slice(0, 2) }, role: 'ADMIN', status: 'ACTIVE', department: 'MAIN', isMainAdmin: true } })).toBe(1);
  }, 60000);
  it('rolls a real user update back when its audit write fails', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: ids[2] } });
    const originalTransaction = prisma.$transaction.bind(prisma);
    // Inject failure only into the audit method, inside a genuine PostgreSQL transaction.
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation((async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      originalTransaction(async tx => callback(new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === 'auditLog') return new Proxy(target.auditLog, { get(delegate, method) {
            if (method === 'create') return async () => { throw new Error('Synthetic audit failure'); };
            return Reflect.get(delegate, method);
          } });
          return Reflect.get(target, prop, receiver);
        },
      })))) as typeof prisma.$transaction);
    try { expect((await UpdateUserRoleService(ids[2], 'ADMIN', ids[0], 'FIRE', false)).code).toBe(500); }
    finally { spy.mockRestore(); }
    const after = await prisma.user.findUniqueOrThrow({ where: { id: ids[2] } });
    expect(after).toMatchObject({ role: 'USER', status: 'ACTIVE', department: null, isMainAdmin: false });
    expect(after.updatedAt).toEqual(before.updatedAt);
  }, 30000);
  it('atomically deactivates a citizen and revokes their session with an audit', async () => {
    const token = await prisma.token.create({ data: { userId: ids[2], type: 'REFRESH', token: randomUUID(), expiresAt: new Date(Date.now() + 60000) } });
    expect((await UpdateUserStatusService(ids[2], 'INACTIVE', ids[0])).code).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids[2] } })).status).toBe('INACTIVE');
    expect((await prisma.token.findUniqueOrThrow({ where: { id: token.id } })).revokedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { actorId: ids[0], entityId: ids[2], action: 'USER_STATUS_CHANGED' } })).toBe(1);
  }, 30000);
});
