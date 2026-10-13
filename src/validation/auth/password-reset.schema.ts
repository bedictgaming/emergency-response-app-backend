import { z } from "zod";

export const requestPasswordResetSchema = z.object({
  body: z.object({ email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()) }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(32).max(256),
    password: z.string().min(12).max(128)
      .regex(/[A-Z]/, "Password requires an uppercase letter")
      .regex(/[a-z]/, "Password requires a lowercase letter")
      .regex(/[0-9]/, "Password requires a number"),
  }),
});
