import { Request, Response } from "express";
import {
  GetIncidentsByBarangayService,
  GetIncidentsByTypeService,
  GetResolvedSummaryService,
  GetDashboardAnalyticsService,
} from "@/services/analytics";
import type { JwtPayload } from "@/lib/jwt";
import { departmentIncidentScope } from "@/lib/department-access";

export class AnalyticsController {
  private scope(req: Request) { return departmentIncidentScope(req.user as JwtPayload); }
  // GET /analytics/v1/incidents-by-barangay
  public getIncidentsByBarangay = async (req: Request, res: Response) => {
    const { from, to, typeId } = req.query;
    const filters = {
      ...(from && { from: new Date(from as string) }),
      ...(to && { to: new Date(to as string) }),
      ...(typeId && { typeId: typeId as string }),
      scope: this.scope(req),
    };

    const result = await GetIncidentsByBarangayService(filters);
    return res.status(result.code).json(result);
  };

  // GET /analytics/v1/incidents-by-type
  public getIncidentsByType = async (req: Request, res: Response) => {
    const { from, to, barangayId } = req.query;
    const filters = {
      ...(from && { from: new Date(from as string) }),
      ...(to && { to: new Date(to as string) }),
      ...(barangayId && { barangayId: barangayId as string }),
      scope: this.scope(req),
    };

    const result = await GetIncidentsByTypeService(filters);
    return res.status(result.code).json(result);
  };

  // GET /analytics/v1/resolved-summary
  public getResolvedSummary = async (req: Request, res: Response) => {
    const { month, year, barangayId } = req.query;
    const filters = {
      ...(month && { month: parseInt(month as string, 10) }),
      ...(year && { year: parseInt(year as string, 10) }),
      ...(barangayId && { barangayId: barangayId as string }),
      scope: this.scope(req),
    };

    const result = await GetResolvedSummaryService(filters);
    return res.status(result.code).json(result);
  };

  // GET /analytics/v1/dashboard
  public getDashboard = async (req: Request, res: Response) => {
    const result = await GetDashboardAnalyticsService(this.scope(req));
    return res.status(result.code).json(result);
  };
}
