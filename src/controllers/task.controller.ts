import { Request, Response } from "express";
import { JwtPayload } from "@/lib/jwt";
import {
  GetAllTasksService,
  GetTaskService,
  CreateTaskService,
  UpdateTaskService,
  DeleteTaskService,
} from "@/services/task";
import { TaskStatus, TaskPriority } from "@/generated/prisma";
import { departmentTaskScope } from "@/lib/department-access";

type AuthenticatedRequest = Request & { user?: JwtPayload };

export class TaskController {
  // GET /tasks/v1/
  public getAll = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { incidentId, assignedTo, status, priority } = req.query;

    const filters = {
      ...(incidentId && { incidentId: incidentId as string }),
      ...(assignedTo && { assignedTo: assignedTo as string }),
      ...(status && { status: status as TaskStatus }),
      ...(priority && { priority: priority as TaskPriority }),
      ...(authReq.user!.role === "RESPONDER" && { assignedUserId: authReq.user!.sub }),
      ...(["ADMIN", "DISPATCHER"].includes(authReq.user!.role) && { taskScope: departmentTaskScope(authReq.user!) }),
    };

    const result = await GetAllTasksService(filters);
    return res.status(result.code).json(result);
  };

  // GET /tasks/v1/:id
  public getById = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const id = req.params.id as string;
    const result = await GetTaskService(id, authReq.user!.sub, authReq.user!.role);
    return res.status(result.code).json(result);
  };

  // POST /incidents/:incidentId/tasks/v1/
  public create = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const incidentId = req.params.incidentId as string;
    const result = await CreateTaskService(incidentId, req.body, authReq.user!.sub);
    return res.status(result.code).json(result);
  };

  // PUT /tasks/v1/:id
  public update = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const id = req.params.id as string;
    const requesterId = authReq.user!.sub;
    const requesterRole = authReq.user!.role;
    const result = await UpdateTaskService(id, req.body, requesterId, requesterRole);
    return res.status(result.code).json(result);
  };

  // DELETE /tasks/v1/:id
  public delete = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await DeleteTaskService(id);
    return res.status(result.code).json(result);
  };
}
