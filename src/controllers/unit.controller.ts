import { Request, Response } from "express";
import {
  GetAllUnitsService,
  GetUnitService,
  CreateUnitService,
  UpdateUnitService,
  DeleteUnitService,
} from "@/services/unit";
import { UnitStatus } from "@/generated/prisma";
import { JwtPayload } from "@/lib/jwt";
import { departmentUnitScope } from "@/lib/department-access";

export class UnitController {
  // GET /units/v1/
  public getAll = async (req: Request, res: Response) => {
    const actor = req.user as JwtPayload;
    const { status, unitType } = req.query;

    const filters = {
      ...(status && { status: status as UnitStatus }),
      ...(unitType && { unitType: unitType as string }),
      ...(["ADMIN", "DISPATCHER"].includes(actor.role) && { scope: departmentUnitScope(actor) }),
      ...(actor.role === "RESPONDER" && { responderUserId: actor.sub }),
    };

    const result = await GetAllUnitsService(filters);
    return res.status(result.code).json(result);
  };

  // GET /units/v1/:id
  public getById = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await GetUnitService(id);
    return res.status(result.code).json(result);
  };

  // POST /units/v1/
  public create = async (req: Request, res: Response) => {
    const result = await CreateUnitService(req.body);
    return res.status(result.code).json(result);
  };

  // PUT /units/v1/:id
  public update = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await UpdateUnitService(id, req.body);
    return res.status(result.code).json(result);
  };

  // DELETE /units/v1/:id
  public delete = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await DeleteUnitService(id);
    return res.status(result.code).json(result);
  };
}
