import { Request, Response } from "express";
import {
  GetAllRespondersService,
  GetResponderService,
  CreateResponderService,
  UpdateResponderService,
  DeleteResponderService,
} from "@/services/responder";
import { ResponderStatus } from "@/generated/prisma";
import { JwtPayload } from "@/lib/jwt";
import { departmentUnitScope } from "@/lib/department-access";

export class ResponderController {
  // GET /responders/v1/
  public getAll = async (req: Request, res: Response) => {
    const actor = req.user as JwtPayload;
    const { unitId, status } = req.query;

    const filters = {
      ...(unitId && { unitId: unitId as string }),
      ...(status && { status: status as ResponderStatus }),
      ...(["ADMIN", "DISPATCHER"].includes(actor.role) && { unitScope: departmentUnitScope(actor) }),
      ...(actor.role === "RESPONDER" && { userId: actor.sub }),
    };

    const result = await GetAllRespondersService(filters);
    return res.status(result.code).json(result);
  };

  // GET /responders/v1/:id
  public getById = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await GetResponderService(id);
    return res.status(result.code).json(result);
  };

  // POST /responders/v1/
  public create = async (req: Request, res: Response) => {
    const result = await CreateResponderService(req.body);
    return res.status(result.code).json(result);
  };

  // PUT /responders/v1/:id
  public update = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await UpdateResponderService(id, req.body);
    return res.status(result.code).json(result);
  };

  // DELETE /responders/v1/:id
  public delete = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await DeleteResponderService(id);
    return res.status(result.code).json(result);
  };
}
