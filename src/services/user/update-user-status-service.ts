import { UserRepository } from "@/repositories/user.repository";
import { UserStatus } from "@/generated/prisma";
import { writeAuditLog } from "@/lib/audit";

const users = new UserRepository();

export async function UpdateUserStatusService(id: string, status: UserStatus, actorId: string) {
  if (id === actorId && status === UserStatus.INACTIVE) {
    return { code: 400, status: "error", message: "You cannot deactivate your own administrator account" };
  }
  const existing = await users.findById(id);
  if (!existing) return { code: 404, status: "error", message: "User not found" };
  const user = await users.updateStatus(id, status);
  await writeAuditLog({ actorId, action: "USER_STATUS_CHANGED", entityType: "User", entityId: id, metadata: { from: existing.status, to: status } });
  return { code: 200, status: "success", message: `User marked ${status.toLowerCase()}`, data: { user } };
}
