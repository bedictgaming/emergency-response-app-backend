import { NextFunction, Request, Response } from "express";
import { Role } from "@/generated/prisma";
import { JwtPayload } from "@/lib/jwt";
import { actorCanManageUsers } from "@/lib/department-access";
import { permissionsForActor, type PermissionName } from "@/lib/permissions";

type AuthenticatedRequest = Request & { user?: JwtPayload };

/**
 * Middleware to check if the authenticated user has one of the required roles.
 * @param roles Array of allowed roles
 */
export const permittedRole = (roles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;

    if (!authReq.user) {
      return res.status(401).json({
        code: 401,
        status: "error",
        message: "Authentication required",
      });
    }
    if (!roles.includes(authReq.user.role as Role)) {
      return res.status(403).json({
        code: 403,
        status: "error",
        message: "Forbidden: You do not have the required role",
      });
    }

    return next();
  };
};

export const requireMainAdmin = (req: Request, res: Response, next: NextFunction) => {
  const actor = (req as AuthenticatedRequest).user;
  if (!actor) return res.status(401).json({ code: 401, status: "error", message: "Authentication required" });
  if (!actorCanManageUsers(actor)) return res.status(403).json({ code: 403, status: "error", message: "Main administrator access required" });
  return next();
};

/** Enforces a server-derived permission after authentication refreshed the account RBAC state. */
export const requirePermission = (permission: PermissionName) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor) return res.status(401).json({ code: 401, status: "error", message: "Authentication required" });
    // Always derive authorization from the current database-backed role and
    // assignment. The attached permission array is response/UI convenience
    // data only; it may be stale during a rolling reload and must never become
    // an authorization source of truth.
    const permissions = permissionsForActor(actor);
    if (!permissions.includes(permission)) {
      return res.status(403).json({ code: 403, status: "error", message: "Forbidden: missing required permission" });
    }
    return next();
  };
};

/** Authorizes routes shared by citizens and operational staff without trusting client-supplied permissions. */
export const requireAnyPermission = (...required: PermissionName[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor) return res.status(401).json({ code: 401, status: "error", message: "Authentication required" });
    if (!required.some((permission) => permissionsForActor(actor).includes(permission))) {
      return res.status(403).json({ code: 403, status: "error", message: "Forbidden: missing required permission" });
    }
    return next();
  };
};
