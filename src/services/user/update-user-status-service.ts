import { UserStatus } from "@/generated/prisma";
import { ensureMainAdministratorRemains, UserAdministrationError, userAdministrationFailure, withUserAdministration } from '@/lib/user-administration';

export async function UpdateUserStatusService(id: string, status: UserStatus, actorId: string) {
  try {
    return await withUserAdministration(id, actorId, async (tx, existing) => {
      if (id === actorId && status === UserStatus.INACTIVE) {
        throw new UserAdministrationError(400, 'You cannot deactivate your own administrator account');
      }
      await ensureMainAdministratorRemains(tx, existing, { ...existing, status });
      const user = await tx.user.update({ where: { id }, data: { status },
        select: { id: true, name: true, email: true, role: true, status: true, updatedAt: true } });
      if (status === UserStatus.INACTIVE) {
        await tx.token.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.responder.updateMany({ where: { userId: id }, data: { status: 'OFF_DUTY' } });
      }
      await tx.auditLog.create({ data: { actorId, action: 'USER_STATUS_CHANGED', entityType: 'User', entityId: id,
        metadata: { from: existing.status, to: status } } });
      return { code: 200, status: 'success', message: `User marked ${status.toLowerCase()}`, data: { user } };
    });
  } catch (error) {
    return userAdministrationFailure(error, 'Failed to update user status');
  }
}
