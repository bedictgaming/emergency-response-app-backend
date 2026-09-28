import { z } from "zod";
import { ResponseService, ServiceResponseStatus } from "@/generated/prisma";

export const updateServiceResponseSchema = z.object({
  params: z.object({ id: z.string().uuid(), service: z.nativeEnum(ResponseService) }),
  body: z.object({ status: z.nativeEnum(ServiceResponseStatus) }),
});
