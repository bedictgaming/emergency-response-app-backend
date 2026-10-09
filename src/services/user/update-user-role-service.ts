import { Department, Role } from "@/generated/prisma";
import { isMainAdministrator } from '@/lib/permissions';
import { ensureMainAdministratorRemains, UserAdministrationError, userAdministrationFailure, withUserAdministration } from '@/lib/user-administration';

export const UpdateUserRoleService = async (id: string, role: Role, actorId?: string, department?: Department | null, isMainAdmin = false) => {
  try {
    if (role === Role.RESPONDER) return { code: 400, status: 'error', message: 'Responder access has been retired' };
    if ((role === Role.ADMIN || role === Role.DISPATCHER) && !department) {
      return { code: 400, status: "error", message: "An operational department is required" };
    }
    if ((department === Department.MAIN && (role !== Role.ADMIN || !isMainAdmin))
      || (isMainAdmin && (role !== Role.ADMIN || department !== Department.MAIN))) {
      return { code: 400, status: "error", message: "The MAIN assignment is reserved for the main administrator" };
    }
    return await withUserAdministration(id, actorId, async (tx, existing) => {
      const assignment = { role, department: role === Role.ADMIN || role === Role.DISPATCHER ? department ?? null : null, isMainAdmin: role === Role.ADMIN && isMainAdmin };
      if (id === actorId && isMainAdministrator(existing) && !isMainAdministrator(assignment)) {
        throw new UserAdministrationError(400, 'You cannot remove your own main administrator access or change your own department');
      }
      if (existing.responder || existing.role === Role.RESPONDER) {
        throw new UserAdministrationError(409, 'Retired responder records are retained for audit and cannot be reassigned here');
      }
      await ensureMainAdministratorRemains(tx, existing, { ...assignment, status: existing.status });
      const user = await tx.user.update({ where: { id }, data: assignment,
        select: { id: true, name: true, email: true, role: true, department: true, isMainAdmin: true, updatedAt: true } });
      await tx.auditLog.create({ data: { actorId, action: 'USER_ROLE_CHANGED', entityType: 'User', entityId: id,
        metadata: { from: existing.role, to: role, fromDepartment: existing.department, department: assignment.department,
          fromIsMainAdmin: existing.isMainAdmin, isMainAdmin: assignment.isMainAdmin } } });
      return { code: 200, status: 'success', message: `User role successfully updated to ${role}`, data: { user } };
    });
  } catch (error) {
    return userAdministrationFailure(error, 'Failed to update user role');
  }
};
