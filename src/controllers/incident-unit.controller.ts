import { Request, Response } from "express";
import {
  GetIncidentUnitsService,
  GetIncidentUnitService,
  DispatchUnitService,
  UpdateIncidentUnitService,
  RemoveIncidentUnitService,
  RemoveIncidentUnitByPairService,
} from "@/services/incident-unit";
import { IncidentUnitStatus } from "@/generated/prisma";
import { JwtPayload } from "@/lib/jwt";
import { departmentDispatchScope } from "@/lib/department-access";

type AuthenticatedRequest = Request & { user?: JwtPayload };

export class IncidentUnitController {
  // GET /incident-units/v1/ or GET /incidents/v1/:id/units
  public getAll = async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user!;
    const incidentId = (req.params.incidentId as string) || (req.query.incidentId as string);
    const { unitId, status } = req.query;

    const filters = {
      ...(incidentId && { incidentId }),
      ...(unitId && { unitId: unitId as string }),
      ...(status && { status: status as IncidentUnitStatus }),
      ...(["ADMIN", "DISPATCHER"].includes(user.role) && { dispatchScope: departmentDispatchScope(user) }),
    };

    const result = await GetIncidentUnitsService(filters, user.sub, user.role);
    return res.status(result.code).json(result);
  };

  // GET /incident-units/v1/:id
  public getById = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const user = (req as AuthenticatedRequest).user!;
    const result = await GetIncidentUnitService(id, user.sub, user.role);
    return res.status(result.code).json(result);
  };

  // POST /incidents/v1/:incidentId/units
  public dispatch = async (req: Request, res: Response) => {
    const incidentId = req.params.incidentId as string;
    const result = await DispatchUnitService(incidentId, req.body, (req as AuthenticatedRequest).user!);
    return res.status(result.code).json(result);
  };

  // PUT /incident-units/v1/:id
  public update = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const user = (req as AuthenticatedRequest).user!;
    const result = await UpdateIncidentUnitService(id, req.body, user.sub, user.role);
    return res.status(result.code).json(result);
  };

  // DELETE /incident-units/v1/:id
  public remove = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await RemoveIncidentUnitService(id, (req as AuthenticatedRequest).user!.sub);
    return res.status(result.code).json(result);
  };

  // DELETE /incidents/v1/:incidentId/units/:unitId
  public removeByPair = async (req: Request, res: Response) => {
    const incidentId = req.params.incidentId as string;
    const unitId = req.params.unitId as string;
    const result = await RemoveIncidentUnitByPairService(incidentId, unitId, (req as AuthenticatedRequest).user!.sub);
    return res.status(result.code).json(result);
  };
}
