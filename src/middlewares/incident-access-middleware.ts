import { NextFunction, Request, Response } from "express";
import { JwtPayload } from "@/lib/jwt";
import { prisma } from "@/lib/prisma";
import { responderIncidentScope } from '@/lib/incident-scope';
import { departmentIncidentScope } from '@/lib/department-access';

type AuthenticatedRequest = Request & { user?: JwtPayload };

/** Citizens may only read or append evidence to incidents they reported. */
export const requireIncidentAccess = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const user = (req as AuthenticatedRequest).user!;
  const incidentId = (req.params.incidentId || req.params.id) as string | undefined;
  if (!incidentId) {
    return res.status(400).json({ code: 400, status: "error", message: "Incident id is required" });
  }

  if (["ADMIN", "DISPATCHER"].includes(user.role)) {
    const allowed = await prisma.incident.findFirst({ where: { incidentId, ...departmentIncidentScope(user) }, select: { incidentId: true } });
    return allowed ? next() : res.status(403).json({ code: 403, status: "error", message: "Incident is outside your department" });
  }

  if (user.role === "RESPONDER") {
    const assigned = await prisma.incident.findFirst({ where: { incidentId, ...responderIncidentScope(user.sub) }, select: { incidentId: true } });
    return assigned ? next() : res.status(403).json({ code: 403, status: 'error', message: 'Incident is outside your assignments' });
  }
  const incident = await prisma.incident.findUnique({
    where: { incidentId },
    select: { reportedBy: true },
  });
  if (!incident) {
    return res.status(404).json({ code: 404, status: "error", message: "Incident not found" });
  }
  if (incident.reportedBy !== user.sub) {
    return res.status(403).json({ code: 403, status: "error", message: "You cannot access another citizen's incident" });
  }
  return next();
};
