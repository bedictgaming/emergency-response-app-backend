import { z } from "zod";
import { Department, Role } from "@/generated/prisma";

export const updateUserRoleSchema = z.object({
  params: z.object({
    id: z
      .string({ message: "User ID is required" })
      .uuid("User ID must be a valid UUID"),
  }),
  body: z.object({
    role: z.enum([Role.USER, Role.DISPATCHER, Role.ADMIN], {
      message: "role must be one of: USER, DISPATCHER, ADMIN",
    }),
    department: z.nativeEnum(Department).nullable().optional(),
    isMainAdmin: z.boolean().optional(),
  }).superRefine((body, context) => {
    if ((body.role === Role.ADMIN || body.role === Role.DISPATCHER) && !body.department) context.addIssue({ code: "custom", path: ["department"], message: "Operational accounts require an explicit department" });
    if (body.department === Department.MAIN && (body.role !== Role.ADMIN || body.isMainAdmin !== true)) context.addIssue({ code: "custom", path: ["department"], message: "The MAIN department is reserved for the main administrator" });
    if (body.isMainAdmin && (body.role !== Role.ADMIN || body.department !== Department.MAIN)) context.addIssue({ code: "custom", path: ["isMainAdmin"], message: "Main-admin access requires an ADMIN in the MAIN department" });
  }),
});

export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>["body"];
