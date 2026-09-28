import { Department, Role } from "@/generated/prisma";

export const Permission = {
  IncidentCreateOwn: "incident:create-own",
  IncidentReadOwn: "incident:read-own",
  IncidentReadAssigned: "incident:read-assigned",
  IncidentReadDepartment: "incident:read-department",
  IncidentReadAll: "incident:read-all",
  IncidentManageDepartment: "incident:manage-department",
  IncidentManageAll: "incident:manage-all",
  EvidenceReadOwn: "evidence:read-own",
  EvidenceReadAssigned: "evidence:read-assigned",
  EvidenceReadDepartment: "evidence:read-department",
  DispatchUpdateAssigned: "dispatch:update-assigned",
  DispatchManageDepartment: "dispatch:manage-department",
  TaskUpdateAssigned: "task:update-assigned",
  TaskManageDepartment: "task:manage-department",
  AlertRead: "alert:read",
  AlertSendDepartment: "alert:send-department",
  AnalyticsReadDepartment: "analytics:read-department",
  ReferenceManage: "reference:manage",
  UserManage: "user:manage",
  AuditRead: "audit:read",
} as const;

export type PermissionName = typeof Permission[keyof typeof Permission];

type PermissionActor = {
  role: Role | string;
  department?: Department | null;
  isMainAdmin?: boolean;
};

export function isMainAdministrator(actor: PermissionActor): boolean {
  return actor.role === Role.ADMIN
    && actor.department === Department.MAIN
    && actor.isMainAdmin === true;
}

export function hasValidOperationalAssignment(actor: PermissionActor): boolean {
  if (actor.role !== Role.ADMIN && actor.role !== Role.DISPATCHER) return true;
  if (!actor.department) return false;
  if (actor.department === Department.MAIN) return isMainAdministrator(actor);
  return actor.isMainAdmin !== true;
}

export function permissionsForActor(actor: PermissionActor): PermissionName[] {
  const common = [Permission.AlertRead];
  if (actor.role === Role.USER) {
    return [Permission.IncidentCreateOwn, Permission.IncidentReadOwn, Permission.EvidenceReadOwn, ...common];
  }
  if (actor.role === Role.RESPONDER) {
    return [
      Permission.IncidentReadAssigned,
      Permission.EvidenceReadAssigned,
      Permission.DispatchUpdateAssigned,
      Permission.TaskUpdateAssigned,
      ...common,
    ];
  }
  if (!hasValidOperationalAssignment(actor)) return common;

  const operational = [
    Permission.IncidentReadDepartment,
    Permission.IncidentManageDepartment,
    Permission.EvidenceReadDepartment,
    Permission.DispatchManageDepartment,
    Permission.TaskManageDepartment,
    Permission.AlertSendDepartment,
    Permission.AnalyticsReadDepartment,
    ...common,
  ];
  if (isMainAdministrator(actor)) {
    return [
      ...operational,
      Permission.IncidentReadAll,
      Permission.IncidentManageAll,
      Permission.ReferenceManage,
      Permission.UserManage,
      Permission.AuditRead,
    ];
  }
  return operational;
}

export function withPermissions<T extends PermissionActor>(user: T) {
  return { ...user, permissions: permissionsForActor(user) };
}
