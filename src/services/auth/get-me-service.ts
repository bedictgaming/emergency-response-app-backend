import { prisma } from "@/lib/prisma";
import { withPermissions } from "@/lib/permissions";

export const GetMeService = async (userId: string) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        isMainAdmin: true,
        emailVerified: true,
      }
    });

    if (!user) {
      return { code: 404, status: "error", message: "User not found" };
    }

    return {
      code: 200,
      status: "success",
      data: { user: withPermissions(user) },
    };
  } catch (error) {
    console.error("GetMeService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch user data" };
  }
};
