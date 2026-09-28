import { z } from "zod";
import { VerificationStatus } from "@/generated/prisma";

export const verifyIncidentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    verificationStatus: z.enum([VerificationStatus.VERIFIED, VerificationStatus.REJECTED]),
    verificationNotes: z.string().trim().max(2000).optional(),
  }).superRefine((data, ctx) => {
    if (data.verificationStatus === VerificationStatus.REJECTED && !data.verificationNotes) {
      ctx.addIssue({ code: "custom", path: ["verificationNotes"], message: "Rejection notes are required" });
    }
  }),
});

export type VerifyIncidentInput = z.infer<typeof verifyIncidentSchema>["body"];
