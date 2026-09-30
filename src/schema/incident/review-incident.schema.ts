import { z } from "zod";

const reason = z.string().trim().min(10, "Explain the reason using at least 10 characters").max(500);
export const flagIncidentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason }),
});
export const reviewIncidentFlagSchema = z.object({
  params: z.object({ id: z.string().uuid(), flagId: z.string().uuid() }),
  body: z.object({ status: z.enum(["CONFIRMED", "DISMISSED"]), reviewNotes: reason, expectedUpdatedAt: z.iso.datetime() }),
});
export const listReviewFlagsSchema = z.object({
  query: z.object({ page: z.coerce.number().int().positive().optional() }),
});
export const deleteIncidentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason, confirmation: z.literal("DELETE") }),
});
