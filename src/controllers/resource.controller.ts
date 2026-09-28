import { Request, Response } from "express";
import {
  GetAllResourcesService,
  GetResourceService,
  GetUnitResourcesService,
  CreateResourceService,
  UpdateResourceService,
  DeleteResourceService,
} from "@/services/resource";
import { ResourceStatus } from "@/generated/prisma";
import { JwtPayload } from "@/lib/jwt";
import { departmentUnitScope } from "@/lib/department-access";

export class ResourceController {
  // GET /resources/v1/
  public getAll = async (req: Request, res: Response) => {
    const actor = req.user as JwtPayload;
    const { unitId, status, resourceType } = req.query;

    const filters = {
      ...(unitId && { unitId: unitId as string }),
      ...(status && { status: status as ResourceStatus }),
      ...(resourceType && { resourceType: resourceType as string }),
      ...(["ADMIN", "DISPATCHER"].includes(actor.role) && { unitScope: departmentUnitScope(actor) }),
      ...(actor.role === "RESPONDER" && { responderUserId: actor.sub }),
    };

    const result = await GetAllResourcesService(filters);
    return res.status(result.code).json(result);
  };

  // GET /resources/v1/:id
  public getById = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await GetResourceService(id);
    return res.status(result.code).json(result);
  };

  // GET /units/v1/:unitId/resources
  public getByUnit = async (req: Request, res: Response) => {
    const unitId = req.params.unitId as string;
    const result = await GetUnitResourcesService(unitId);
    return res.status(result.code).json(result);
  };

  // POST /resources/v1/
  public create = async (req: Request, res: Response) => {
    const result = await CreateResourceService(req.body);
    return res.status(result.code).json(result);
  };

  // PUT /resources/v1/:id
  public update = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await UpdateResourceService(id, req.body);
    return res.status(result.code).json(result);
  };

  // DELETE /resources/v1/:id
  public delete = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await DeleteResourceService(id);
    return res.status(result.code).json(result);
  };
}
