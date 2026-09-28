import { Request, Response } from "express";
import {
  GetAllBarangaysService,
  GetBarangayService,
  GetBarangayIncidentsService,
  UpdateBarangayService,
} from "@/services/barangay";
import { departmentIncidentScope } from "@/lib/department-access";
import { JwtPayload } from "@/lib/jwt";

export class BarangayController {
  // GET /barangays/v1/
  public getAll = async (_req: Request, res: Response) => {
    const result = await GetAllBarangaysService();
    return res.status(result.code).json(result);
  };

  // GET /barangays/v1/:id
  public getById = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await GetBarangayService(id);
    return res.status(result.code).json(result);
  };

  // GET /barangays/v1/:id/incidents
  public getIncidents = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await GetBarangayIncidentsService(id, departmentIncidentScope(req.user as JwtPayload));
    return res.status(result.code).json(result);
  };

  // PUT /barangays/v1/:id
  public update = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await UpdateBarangayService(id, req.body);
    return res.status(result.code).json(result);
  };
}
