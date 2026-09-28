import { z } from "zod";
import { ResponseService } from "@/generated/prisma";

export const checkNearbyIncidentSchema = z.object({
  body: z.object({
    category: z.string().min(1).max(50),
    requestedServices: z.array(z.nativeEnum(ResponseService)).max(4).optional(),
    barangayName: z.string().min(1).max(100),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }).superRefine((body, context) => {
    const isOther = body.category.trim().toLowerCase() === "other";
    const requested = new Set(body.requestedServices ?? []);
    if (isOther && requested.size < 2) {
      context.addIssue({ code: "custom", path: ["requestedServices"], message: "Select at least two response services for an Other emergency" });
    }
    if (!isOther && requested.size > 0) {
      context.addIssue({ code: "custom", path: ["requestedServices"], message: "Multiple response services are only available for the Other category" });
    }
  }),
});

export type CheckNearbyIncidentInput = z.infer<typeof checkNearbyIncidentSchema>["body"];
