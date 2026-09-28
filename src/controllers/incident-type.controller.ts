import { Request, Response } from "express";
import {
  GetAllIncidentTypesService,
  GetIncidentTypeService,
  CreateIncidentTypeService,
  UpdateIncidentTypeService,
  DeleteIncidentTypeService,
} from "@/services/incident-type";

export class IncidentTypeController {
  // GET /incident-types/v1/
  public getAll = async (_req: Request, res: Response) => {
    const result = await GetAllIncidentTypesService();
    return res.status(result.code).json(result);
  };

  // GET /incident-types/v1/:id
  public getById = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await GetIncidentTypeService(id);
    return res.status(result.code).json(result);
  };

  // POST /incident-types/v1/
  public create = async (req: Request, res: Response) => {
    const result = await CreateIncidentTypeService(req.body);
    return res.status(result.code).json(result);
  };

  // PUT /incident-types/v1/:id
  public update = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await UpdateIncidentTypeService(id, req.body);
    return res.status(result.code).json(result);
  };

  // DELETE /incident-types/v1/:id
  public delete = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await DeleteIncidentTypeService(id);
    return res.status(result.code).json(result);
  };
}
