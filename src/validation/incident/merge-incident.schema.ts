import { z } from "zod";

export const mergeIncidentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ targetIncidentId: z.string().uuid(), reason: z.string().trim().min(10).max(500) }),
});
