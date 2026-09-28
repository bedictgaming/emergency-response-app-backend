import { z } from "zod";
import { UserStatus } from "@/generated/prisma";

export const updateUserStatusSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ status: z.nativeEnum(UserStatus) }),
});
