import { describe, expect, it } from "vitest";
import { Department, Role } from "@/generated/prisma";
import { Permission, hasValidOperationalAssignment, permissionsForActor } from "@/lib/permissions";
import { requireAnyPermission, requirePermission } from "@/middlewares/rbac-middleware";
import { updateUserRoleSchema } from "@/schema/user/update-user-role.schema";

describe("server-derived RBAC permissions", () => {
  it("keeps citizens restricted to their own reports and evidence", () => {
    const permissions = permissionsForActor({ role: Role.USER });
    expect(permissions).toContain(Permission.IncidentCreateOwn);
    expect(permissions).toContain(Permission.IncidentReadOwn);
    expect(permissions).not.toContain(Permission.IncidentManageDepartment);
    expect(permissions).not.toContain(Permission.UserManage);
  });

  it("grants department operations without cross-system user administration", () => {
    const permissions = permissionsForActor({ role: Role.ADMIN, department: Department.MEDICAL, isMainAdmin: false });
    expect(permissions).toContain(Permission.IncidentManageDepartment);
    expect(permissions).toContain(Permission.AnalyticsReadDepartment);
    expect(permissions).not.toContain(Permission.IncidentManageAll);
    expect(permissions).not.toContain(Permission.UserManage);
  });

  it("grants global management only to the explicitly assigned main administrator", () => {
    const permissions = permissionsForActor({ role: Role.ADMIN, department: Department.MAIN, isMainAdmin: true });
    expect(permissions).toContain(Permission.IncidentManageAll);
    expect(permissions).toContain(Permission.UserManage);
  });

  it("rejects malformed operational assignments", () => {
    expect(hasValidOperationalAssignment({ role: Role.ADMIN, department: null })).toBe(false);
    expect(hasValidOperationalAssignment({ role: Role.ADMIN, department: Department.MAIN, isMainAdmin: false })).toBe(false);
    expect(hasValidOperationalAssignment({ role: Role.DISPATCHER, department: Department.MAIN, isMainAdmin: true })).toBe(false);
    expect(hasValidOperationalAssignment({ role: Role.ADMIN, department: Department.FIRE, isMainAdmin: true })).toBe(false);
    expect(permissionsForActor({ role: Role.DISPATCHER, department: Department.MAIN, isMainAdmin: true })).not.toContain(Permission.IncidentReadAll);
    expect(hasValidOperationalAssignment({ role: Role.DISPATCHER, department: Department.FIRE })).toBe(true);
  });

  it("rejects MAIN assignments without the complete main-admin role and flag", () => {
    const params = { id: "11111111-1111-4111-8111-111111111111" };
    expect(updateUserRoleSchema.safeParse({ params, body: { role: Role.ADMIN, department: Department.MAIN, isMainAdmin: false } }).success).toBe(false);
    expect(updateUserRoleSchema.safeParse({ params, body: { role: Role.DISPATCHER, department: Department.MAIN, isMainAdmin: true } }).success).toBe(false);
    expect(updateUserRoleSchema.safeParse({ params, body: { role: Role.ADMIN, department: Department.MAIN, isMainAdmin: true } }).success).toBe(true);
  });

  it("derives permissions from an authenticated database-backed actor when the cached list is absent", () => {
    const middleware = requirePermission(Permission.IncidentCreateOwn);
    const request = { user: { sub: "user-id", role: Role.USER, type: "access" } } as any;
    const response = { status: () => response, json: () => response } as any;
    let continued = false;
    middleware(request, response, () => { continued = true; });
    expect(continued).toBe(true);
  });

  it("ignores a stale permission list and authorizes from the current citizen role", () => {
    const middleware = requirePermission(Permission.IncidentCreateOwn);
    const request = {
      user: {
        sub: "user-id",
        role: Role.USER,
        type: "access",
        permissions: [Permission.AlertRead],
      },
    } as any;
    const response = { status: () => response, json: () => response } as any;
    let continued = false;
    middleware(request, response, () => { continued = true; });
    expect(continued).toBe(true);
  });

  it("ignores a forged permission list that is not granted by the current role", () => {
    const middleware = requirePermission(Permission.UserManage);
    const request = {
      user: {
        sub: "user-id",
        role: Role.USER,
        type: "access",
        permissions: [Permission.UserManage],
      },
    } as any;
    let status = 0;
    const response = { status: (value: number) => { status = value; return response; }, json: () => response } as any;
    middleware(request, response, () => undefined);
    expect(status).toBe(403);
  });

  it("still denies a role that does not own the requested permission", () => {
    const middleware = requirePermission(Permission.UserManage);
    const request = { user: { sub: "user-id", role: Role.USER, type: "access" } } as any;
    let status = 0;
    const response = { status: (value: number) => { status = value; return response; }, json: () => response } as any;
    middleware(request, response, () => undefined);
    expect(status).toBe(403);
  });

  it("lets citizens and assigned operational staff create while denying responders", () => {
    const middleware = requireAnyPermission(Permission.IncidentCreateOwn, Permission.IncidentManageDepartment);
    let status = 0;
    const response = { status: (value: number) => { status = value; return response; }, json: () => response } as any;
    let continued = 0;
    for (const user of [
      { role: Role.USER },
      { role: Role.ADMIN, department: Department.FIRE, isMainAdmin: false },
      { role: Role.DISPATCHER, department: Department.MEDICAL, isMainAdmin: false },
    ]) {
      middleware({ user } as any, response, () => { continued += 1; });
    }
    expect(continued).toBe(3);
    middleware({ user: { role: Role.RESPONDER, permissions: [Permission.IncidentManageDepartment] } } as any, response, () => undefined);
    expect(status).toBe(403);
  });
});
