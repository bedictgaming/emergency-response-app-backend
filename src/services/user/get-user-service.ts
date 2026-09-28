import { UserRepository } from "@/repositories/user.repository";

const userRepository = new UserRepository();

export const GetUserService = async (id: string) => {
  try {
    const user = await userRepository.findDetailById(id);

    if (!user) {
      return { code: 404, status: "error", message: "User not found" };
    }

    return {
      code: 200,
      status: "success",
      data: { user },
    };
  } catch (error) {
    console.error("GetUserService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch user" };
  }
};
