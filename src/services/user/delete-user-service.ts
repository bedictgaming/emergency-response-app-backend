import { UserRepository } from "@/repositories/user.repository";
import { UpdateUserStatusService } from "./update-user-status-service";
import { UserStatus } from "@/generated/prisma";

const userRepository = new UserRepository();

export const DeleteUserService = async (id: string, currentAdminId: string) => {
  try {
    if (id === currentAdminId) {
      return {
        code: 400,
        status: "error",
        message: "You cannot delete your own admin account",
      };
    }

    const existing = await userRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "User not found" };
    }

    const result = await UpdateUserStatusService(id, UserStatus.INACTIVE, currentAdminId);
    return { ...result, message: result.code === 200 ? "User account deactivated; historical emergency records were retained" : result.message };
  } catch (error) {
    console.error("DeleteUserService Error", error);
    return { code: 500, status: "error", message: "Failed to delete user" };
  }
};
