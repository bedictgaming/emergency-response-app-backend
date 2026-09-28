import { UserRepository } from "@/repositories/user.repository";
import { Role } from "@/generated/prisma";

const userRepository = new UserRepository();

interface GetAllUsersFilters {
  role?: Role;
  search?: string;
}

export const GetAllUsersService = async (filters?: GetAllUsersFilters) => {
  try {
    const users = await userRepository.findAll(filters);

    return {
      code: 200,
      status: "success",
      data: { users },
    };
  } catch (error) {
    console.error("GetAllUsersService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch users" };
  }
};
