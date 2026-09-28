import { UserRepository } from "@/repositories/user.repository";
import { Department, Role } from "@/generated/prisma";
import { writeAuditLog } from "@/lib/audit";

const userRepository = new UserRepository();

export const UpdateUserRoleService = async (id: string, role: Role, actorId?: string, department?: Department | null, isMainAdmin = false) => {
  try {
    if ((role === Role.ADMIN || role === Role.DISPATCHER) && !department) {
      return { code: 400, status: "error", message: "An operational department is required" };
    }
    if ((department === Department.MAIN && (role !== Role.ADMIN || !isMainAdmin))
      || (isMainAdmin && (role !== Role.ADMIN || department !== Department.MAIN))) {
      return { code: 400, status: "error", message: "The MAIN assignment is reserved for the main administrator" };
    }
    const existing = await userRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "User not found" };
    }
    if (id === actorId && existing.role === Role.ADMIN && role !== Role.ADMIN) {
      return { code: 400, status: "error", message: "You cannot remove your own administrator role" };
    }
    const detail = await userRepository.findDetailById(id);
    if (detail?.responder && role !== Role.RESPONDER) {
      return { code: 409, status: "error", message: "Remove the responder profile before changing this role" };
    }

    const user = await userRepository.updateRole(id, role, department, isMainAdmin);
    await writeAuditLog({ actorId, action: "USER_ROLE_CHANGED", entityType: "User", entityId: id, metadata: { from: existing.role, to: role, department, isMainAdmin } });

    return {
      code: 200,
      status: "success",
      message: `User role successfully updated to ${role}`,
      data: { user },
    };
  } catch (error) {
    console.error("UpdateUserRoleService Error", error);
    return { code: 500, status: "error", message: "Failed to update user role" };
  }
};
