import { z } from "zod";

export const loginSchema = z.object({
  body: z.object({
    email: z.email("Invalid email format"),
    // Accommodate older, longer passwords; new signup/reset passwords cap at 128.
    password: z.string().min(1, "Password is required").max(4096),
  }),
});
