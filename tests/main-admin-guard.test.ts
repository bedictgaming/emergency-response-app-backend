import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }));
import { Role, Department, UserStatus } from '@/generated/prisma';
import { UpdateUserRoleService } from '@/services/user/update-user-role-service';
import { UpdateUserStatusService } from '@/services/user/update-user-status-service';
import { ensureMainAdministratorRemains, type ManagedUser } from '@/lib/user-administration';
import type { Prisma } from '@/generated/prisma';

const main = { id: 'main', name: 'Synthetic main', email: 'main@example.invalid', role: Role.ADMIN,
  status: UserStatus.ACTIVE, department: Department.MAIN, isMainAdmin: true, responder: null, updatedAt: new Date() };
let tx: ReturnType<typeof transactionMock>;
function transactionMock() {
  return { $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn().mockResolvedValue(main), count: vi.fn().mockResolvedValue(1), update: vi.fn().mockResolvedValue(main) },
    token: { updateMany: vi.fn() }, responder: { updateMany: vi.fn() }, auditLog: { create: vi.fn() } };
}
function target(overrides: Partial<ManagedUser> = {}) {
  tx.user.findUnique.mockResolvedValueOnce(main).mockResolvedValueOnce({ ...main, id: 'target', ...overrides });
}
function unchanged() { expect(tx.user.update).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled(); }
describe('main administrator continuity', () => {
  beforeEach(() => { vi.clearAllMocks(); tx = transactionMock(); mocks.transaction.mockImplementation(callback => callback(tx)); });
  it.each([
    [Role.ADMIN, Department.FIRE, false], [Role.USER, null, false], [Role.DISPATCHER, Department.FIRE, false],
  ] as const)('rejects self-loss of MAIN access (%s/%s)', async (role, department, flag) => {
    expect((await UpdateUserRoleService('main', role, 'main', department, flag)).code).toBe(400); unchanged();
  });
  it('allows retaining the same MAIN assignment and audits in the transaction', async () => {
    expect((await UpdateUserRoleService('main', Role.ADMIN, 'main', Department.MAIN, true)).code).toBe(200);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actorId: 'main', action: 'USER_ROLE_CHANGED' }) }));
    expect(tx.user.count).not.toHaveBeenCalled();
  });
  it('refuses a missing actor before starting any transaction', async () => {
    expect((await UpdateUserRoleService('target', Role.USER)).code).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled(); unchanged();
  });
  it.each([null, { ...main, status: UserStatus.INACTIVE }, { ...main, department: Department.FIRE, isMainAdmin: false },
    { ...main, isMainAdmin: false }, { ...main, role: Role.USER }])('rechecks current actor authority under locks: %s', async actor => {
    tx.user.findUnique.mockResolvedValue(actor);
    expect((await UpdateUserRoleService('target', Role.USER, 'main')).code).toBe(403); unchanged();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('main-admin-bootstrap');
    expect(tx.$queryRaw.mock.calls[1][0].join('')).toContain('ORDER BY id FOR UPDATE');
  });
  it('returns 404 for an absent target', async () => {
    tx.user.findUnique.mockResolvedValueOnce(main).mockResolvedValueOnce(null);
    expect((await UpdateUserRoleService('target', Role.USER, 'main')).code).toBe(404); unchanged();
  });
  it('rejects removal of the final active MAIN assignment', async () => {
    target(); tx.user.count.mockResolvedValue(0);
    expect((await UpdateUserRoleService('target', Role.ADMIN, 'main', Department.FIRE)).code).toBe(409); unchanged();
    expect(tx.user.count).toHaveBeenCalledWith({ where: { id: { not: 'target' }, role: 'ADMIN', status: 'ACTIVE', department: 'MAIN', isMainAdmin: true } });
  });
  it('permits another MAIN assignment to change only when an active MAIN remains', async () => {
    target();
    expect((await UpdateUserRoleService('target', Role.ADMIN, 'main', Department.FIRE)).code).toBe(200);
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'ADMIN', department: 'FIRE', isMainAdmin: false } }));
  });
  it('retains responder-profile role restrictions', async () => {
    target({ role: Role.RESPONDER, department: null, isMainAdmin: false, responder: { responderId: 'responder' } });
    expect((await UpdateUserRoleService('target', Role.USER, 'main')).code).toBe(409); unchanged();
  });
  it.each([[Role.ADMIN, null, false], [Role.ADMIN, Department.MAIN, false], [Role.ADMIN, Department.FIRE, true],
    [Role.DISPATCHER, Department.MAIN, true]] as const)('rejects invalid assignments (%s/%s)', async (role, department, flag) => {
    expect((await UpdateUserRoleService('target', role, 'main', department, flag)).code).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled(); unchanged();
  });
  it('still blocks self-deactivation', async () => {
    expect((await UpdateUserStatusService('main', UserStatus.INACTIVE, 'main')).code).toBe(400); unchanged();
  });
  it('blocks deactivation of the final active MAIN', async () => {
    target(); tx.user.count.mockResolvedValue(0);
    expect((await UpdateUserStatusService('target', UserStatus.INACTIVE, 'main')).code).toBe(409); unchanged();
    expect(tx.token.updateMany).not.toHaveBeenCalled();
  });
  it('preserves citizen deactivation, token revocation and responder off-duty writes in the audited transaction', async () => {
    target({ role: Role.USER, department: null, isMainAdmin: false });
    expect((await UpdateUserStatusService('target', UserStatus.INACTIVE, 'main')).code).toBe(200);
    expect(tx.token.updateMany).toHaveBeenCalledWith({ where: { userId: 'target', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(tx.responder.updateMany).toHaveBeenCalledWith({ where: { userId: 'target' }, data: { status: 'OFF_DUTY' } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'USER_STATUS_CHANGED' }) }));
  });
  it('does not revoke sessions when activating a citizen', async () => {
    target({ role: Role.USER, department: null, isMainAdmin: false, status: UserStatus.INACTIVE });
    expect((await UpdateUserStatusService('target', UserStatus.ACTIVE, 'main')).code).toBe(200);
    expect(tx.token.updateMany).not.toHaveBeenCalled();
  });
  it('does not count inactive MAIN or non-MAIN targets as the last active MAIN', async () => {
    for (const existing of [{ ...main, status: UserStatus.INACTIVE }, { ...main, department: Department.FIRE, isMainAdmin: false }]) {
      await ensureMainAdministratorRemains(tx as unknown as Prisma.TransactionClient, existing, { ...existing, role: Role.USER });
    }
    expect(tx.user.count).not.toHaveBeenCalled();
  });
  it('returns a safe concurrency error rather than a provider error', async () => {
    mocks.transaction.mockRejectedValue({ code: 'P2034', message: 'private provider detail' });
    const result = await UpdateUserStatusService('target', UserStatus.INACTIVE, 'main');
    expect(result.code).toBe(409); expect(result.message).not.toContain('private provider'); unchanged();
  });
});
