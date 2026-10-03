import { Request, Response } from "express";
import { JwtPayload } from "@/lib/jwt";
import {
  GetAllIncidentsService,
  GetIncidentService,
  CreateIncidentService,
  UpdateIncidentService,
  DeleteIncidentService,
  VerifyIncidentService,
  CheckNearbyIncidentService,
  UpdateServiceResponseService,
  MergeIncidentService,
} from "@/services/incident";
import { Department, IncidentStatus, ResponseService, ServiceResponseStatus, SeverityLevel } from "@/generated/prisma";
import { departmentIncidentScope, departmentService } from "@/lib/department-access";
import { isMainAdministrator } from "@/lib/permissions";
import { getCurrentManilaMonth, getManilaMonthRange } from "@/lib/manila-calendar";
import { FlagIncidentService, ListIncidentReviewFlagsService, ReviewIncidentFlagService, reviewDepartmentFor } from "@/services/incident/review-incident-service";

type AuthenticatedRequest = Request & { user?: JwtPayload };

export class IncidentController {
  public checkNearby = async (req: Request, res: Response) => {
    const result = await CheckNearbyIncidentService(req.body);
    return res.status(result.code).json(result);
  };

  // GET /incidents/v1/
  public getAll = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { status, statuses, responseService, serviceStatuses, severityLevel, typeId, locationId, barangayId, reportedBy, from, to, department } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const requestedStatuses = typeof statuses === "string"
      ? statuses
        .split(",")
        .map((value) => value.trim())
        .filter((value): value is IncidentStatus => Object.values(IncidentStatus).includes(value as IncidentStatus))
      : [];
    const requestedResponseService = typeof responseService === "string"
      && Object.values(ResponseService).includes(responseService as ResponseService)
      ? responseService as ResponseService
      : undefined;
    const requestedServiceStatuses = typeof serviceStatuses === "string"
      ? serviceStatuses
        .split(",")
        .map((value) => value.trim())
        .filter((value): value is ServiceResponseStatus => Object.values(ServiceResponseStatus).includes(value as ServiceResponseStatus))
      : [];
    const actorService = departmentService(authReq.user?.department);
    if (requestedResponseService && !isMainAdministrator(authReq.user!) && requestedResponseService !== actorService) {
      return res.status(403).json({ code: 403, status: "error", message: "Cannot filter another department's response state" });
    }

    let operationalScope = ["ADMIN", "DISPATCHER"].includes(authReq.user?.role ?? "")
      ? departmentIncidentScope(authReq.user!)
      : undefined;
    if (isMainAdministrator(authReq.user!) && typeof department === "string" && department !== Department.MAIN
      && Object.values(Department).includes(department as Department)) {
      operationalScope = departmentIncidentScope({ ...authReq.user!, isMainAdmin: false, department: department as Department });
    }
    const filters = {
      ...(typeof req.query.search === "string" && { search: req.query.search.trim() }),
      ...(typeof req.query.typeName === "string" && { typeName: req.query.typeName }),
      ...(req.query.period === "THIS_MONTH" && (() => {
        const { month, year } = getCurrentManilaMonth();
        const { start, end } = getManilaMonthRange(month, year);
        return { historyFrom: start, historyBefore: end };
      })()),
      ...(req.query.period === "LAST_30_DAYS" && { historyFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), historyBefore: new Date() }),
      ...(authReq.user?.role === "RESPONDER" && { responderId: authReq.user.sub }),
      ...(operationalScope && { scope: operationalScope }),
      ...(status && { status: status as IncidentStatus }),
      ...(requestedStatuses.length > 0 && { statuses: requestedStatuses }),
      ...(requestedResponseService && { responseService: requestedResponseService }),
      ...(requestedServiceStatuses.length > 0 && { serviceStatuses: requestedServiceStatuses }),
      ...(severityLevel && { severityLevel: severityLevel as SeverityLevel }),
      ...(typeId && { typeId: typeId as string }),
      ...(locationId && { locationId: locationId as string }),
      ...(barangayId && { barangayId: barangayId as string }),
      ...(authReq.user?.role === "USER"
        ? { reportedBy: authReq.user.sub }
        : reportedBy && { reportedBy: reportedBy as string }),
      ...(from && { from: new Date(from as string) }),
      ...(to && { to: new Date(to as string) }),
      page,
      limit,
      includeTotal: req.query.includeTotal !== "false",
      includeServiceSummary: req.query.includeServiceSummary === "true",
      includeVerifiedSummary: req.query.includeVerifiedSummary === "true",
      includeAttachments: req.query.includeAttachments === "true",
      includeUnits: req.query.includeUnits === "true",
      reviewDepartment: req.query.includeReviewFlags === "true" ? reviewDepartmentFor(authReq.user!) : undefined,
    };

    const result = await GetAllIncidentsService(filters);
    return res.status(result.code).json(result);
  };

  // GET /incidents/v1/:id
  public getById = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await GetIncidentService(id, reviewDepartmentFor((req as AuthenticatedRequest).user!));
    return res.status(result.code).json(result);
  };

  // POST /incidents/v1/
  public create = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const reportedBy = authReq.user!.sub;
    const result = await CreateIncidentService(req.body, reportedBy);
    return res.status(result.code).json(result);
  };

  // PUT /incidents/v1/:id
  public update = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    if (req.body.status && !isMainAdministrator(authReq.user!)) return res.status(403).json({ code: 403, status: "error", message: "Update your department response status instead" });
    const id = req.params.id as string;
    const result = await UpdateIncidentService(id, req.body, authReq.user!.sub);
    return res.status(result.code).json(result);
  };

  public updateServiceResponse = async (req: Request, res: Response) => {
    const actor = (req as AuthenticatedRequest).user!;
    const result = await UpdateServiceResponseService(req.params.id as string, req.params.service as ResponseService, req.body.status as ServiceResponseStatus, actor);
    return res.status(result.code).json(result);
  };

  public merge = async (req: Request, res: Response) => {
    const actor = (req as AuthenticatedRequest).user!;
    const result = await MergeIncidentService(req.params.id as string, req.body.targetIncidentId, req.body.reason, actor);
    return res.status(result.code).json(result);
  };

  // DELETE /incidents/v1/:id
  public delete = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const id = req.params.id as string;
    const result = await DeleteIncidentService(id, authReq.user!, req.body);
    return res.status(result.code).json(result);
  };

  public flag = async (req: Request, res: Response) => {
    const result = await FlagIncidentService(req.params.id as string, req.body.reason, (req as AuthenticatedRequest).user!);
    return res.status(result.code).json(result);
  };

  public reviewFlag = async (req: Request, res: Response) => {
    const result = await ReviewIncidentFlagService(req.params.id as string, req.params.flagId as string, req.body, (req as AuthenticatedRequest).user!);
    return res.status(result.code).json(result);
  };

  public listReviewFlags = async (req: Request, res: Response) => {
    const result = await ListIncidentReviewFlagsService(Math.max(1, Number(req.query.page) || 1), (req as AuthenticatedRequest).user!);
    return res.status(result.code).json(result);
  };

  public verify = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const result = await VerifyIncidentService(
      req.params.id as string,
      req.body,
      authReq.user!.sub,
      req.ip,
    );
    return res.status(result.code).json(result);
  };
}
