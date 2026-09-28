import { Request, Response } from "express";
import { JwtPayload } from "@/lib/jwt";
import {
  GetAllAlertsService,
  GetAlertService,
  CreateAlertService,
  DeleteAlertService,
} from "@/services/alert";
import { AlertType, AlertSeverity } from "@/generated/prisma";

type AuthenticatedRequest = Request & { user?: JwtPayload };

export class AlertController {
  // GET /alerts/v1/
  public getAll = async (req: Request, res: Response) => {
    const { alertType, severity, incidentId, locationId } = req.query;

    const filters = {
      ...(alertType && { alertType: alertType as AlertType }),
      ...(severity && { severity: severity as AlertSeverity }),
      ...(incidentId && { incidentId: incidentId as string }),
      ...(locationId && { locationId: locationId as string }),
    };

    const result = await GetAllAlertsService(filters);
    if (result.code === 503) res.setHeader("Retry-After", "2");
    return res.status(result.code).json(result);
  };

  // GET /alerts/v1/:id
  public getById = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await GetAlertService(id);
    if (result.code === 503) res.setHeader("Retry-After", "2");
    return res.status(result.code).json(result);
  };

  // POST /alerts/v1/
  public create = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const sentBy = authReq.user!.sub;
    const result = await CreateAlertService(req.body, sentBy);
    return res.status(result.code).json(result);
  };

  // DELETE /alerts/v1/:id
  public delete = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await DeleteAlertService(id);
    return res.status(result.code).json(result);
  };
}
