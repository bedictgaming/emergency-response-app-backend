import { z } from "zod";

export const googleLinkSchema = z.object({ body: z.object({
  accountId: z.uuid("Reload Settings to confirm your account"),
  password: z.string().min(1, "Confirm your current password").max(4096),
}).strict() });
