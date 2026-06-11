import { z } from 'zod';

export const resendSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export type ResendInput = z.infer<typeof resendSchema>;
