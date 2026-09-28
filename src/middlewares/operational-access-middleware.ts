import { NextFunction, Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import type { JwtPayload } from "@/lib/jwt";
import { departmentDispatchScope, departmentIncidentScope, departmentService, departmentTaskScope, departmentUnitScope } from "@/lib/department-access";
import { unitTypeSupportsService } from "@/lib/response-services";
import { isMainAdministrator } from "@/lib/permissions";

const denied = (res: Response) => res.status(403).json({ code: 403, status: "error", message: "Record is outside your department or assignment" });

export const requireIncidentUnitDepartment = async (req: Request, res: Response, next: NextFunction) => {
  const actor = req.user as JwtPayload;
  if (actor.role === "RESPONDER") return next();
  const record = await prisma.incidentUnit.findFirst({ where: { incidentUnitId: req.params.id as string, ...departmentDispatchScope(actor) }, select: { incidentUnitId: true } });
  return record ? next() : denied(res);
};

export const requireTaskDepartment = async (req: Request, res: Response, next: NextFunction) => {
  const actor = req.user as JwtPayload;
  if (actor.role === "RESPONDER") return next();
  const record = await prisma.task.findFirst({ where: { taskId: req.params.id as string, ...departmentTaskScope(actor) }, select: { taskId: true } });
  return record ? next() : denied(res);
};

export const requireAttachmentDepartment = async (req: Request, res: Response, next: NextFunction) => {
  const actor = req.user as JwtPayload;
  if (!["ADMIN", "DISPATCHER"].includes(actor.role)) return next();
  const record = await prisma.attachment.findFirst({ where: { attachmentId: req.params.id as string, incident: departmentIncidentScope(actor) }, select: { attachmentId: true } });
  return record ? next() : denied(res);
};

export const requireUnitDepartment = async (req: Request, res: Response, next: NextFunction) => {
  const actor = req.user as JwtPayload;
  const id = (req.params.unitId || req.params.id) as string;
  const where = actor.role === "RESPONDER"
    ? { unitId: id, responders: { some: { userId: actor.sub } } }
    : { unitId: id, ...departmentUnitScope(actor) };
  return await prisma.unit.findFirst({ where, select: { unitId: true } }) ? next() : denied(res);
};

export const requireResponderDepartment = async (req: Request, res: Response, next: NextFunction) => {
  const actor = req.user as JwtPayload;
  const where = actor.role === "RESPONDER"
    ? { responderId: req.params.id as string, userId: actor.sub }
    : { responderId: req.params.id as string, unit: departmentUnitScope(actor) };
  return await prisma.responder.findFirst({ where, select: { responderId: true } }) ? next() : denied(res);
};

export const requireResourceDepartment = async (req: Request, res: Response, next: NextFunction) => {
  const actor = req.user as JwtPayload;
  const where = actor.role === "RESPONDER"
    ? { resourceId: req.params.id as string, unit: { responders: { some: { userId: actor.sub } } } }
    : { resourceId: req.params.id as string, unit: departmentUnitScope(actor) };
  return await prisma.resource.findFirst({ where, select: { resourceId: true } }) ? next() : denied(res);
};

export const requireTargetUnitDepartment = async (req: Request, res: Response, next: NextFunction) => {
  const actor = req.user as JwtPayload;
  if (isMainAdministrator(actor)) return next();
  const unitId = (req.body?.unitId || req.params.unitId) as string | undefined;
  if (unitId) {
    return await prisma.unit.findFirst({ where: { unitId, ...departmentUnitScope(actor) }, select: { unitId: true } }) ? next() : denied(res);
  }
  // Updates that do not move a responder/resource to another unit are safe once
  // the existing record has passed its department middleware.
  if (typeof req.body?.unitType !== "string") return next();
  const service = departmentService(actor.department);
  return service && typeof req.body?.unitType === "string" && unitTypeSupportsService(req.body.unitType, [service]) ? next() : denied(res);
};

export const requireTargetResponderDepartment = async (req: Request, res: Response, next: NextFunction) => {
  const actor = req.user as JwtPayload;
  const responderId = req.body?.assignedTo as string | null | undefined;
  if (isMainAdministrator(actor)) return next();
  if (!responderId) {
    const incidentId = req.params.incidentId as string | undefined;
    if (incidentId) {
      const incident = await prisma.incident.findUnique({ where: { incidentId }, select: { requestedServices: true } });
      if (incident && incident.requestedServices.length > 1) return denied(res);
    } else if (req.body?.assignedTo === null) {
      const task = await prisma.task.findUnique({ where: { taskId: req.params.id as string }, select: { incident: { select: { requestedServices: true } } } });
      if (task && task.incident.requestedServices.length > 1) return denied(res);
    }
    return next();
  }
  const responder = await prisma.responder.findFirst({
    where: { responderId, unit: departmentUnitScope(actor) },
    select: { responderId: true },
  });
  return responder ? next() : denied(res);
};

export const requireTargetIncidentDepartment = async (req: Request, res: Response, next: NextFunction) => {
  const actor = req.user as JwtPayload;
  const incidentId = req.body?.incidentId as string | undefined;
  if (!incidentId || isMainAdministrator(actor)) return next();
  const incident = await prisma.incident.findFirst({
    where: { incidentId, ...departmentIncidentScope(actor) },
    select: { incidentId: true },
  });
  return incident ? next() : denied(res);
};
