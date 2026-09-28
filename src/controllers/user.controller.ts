import { Request, Response } from "express";
import { JwtPayload } from "@/lib/jwt";
import {
  GetAllUsersService,
  GetUserService,
  UpdateUserRoleService,
  DeleteUserService,
  UpdateUserStatusService,
} from "@/services/user";
import { Role, UserStatus } from "@/generated/prisma";

type AuthenticatedRequest = Request & { user?: JwtPayload };

export class UserController {
  // GET /users/v1/
  public getAll = async (req: Request, res: Response) => {
    const { role, search } = req.query;

    const filters = {
      ...(role && { role: role as Role }),
      ...(search && { search: search as string }),
    };

    const result = await GetAllUsersService(filters);
    return res.status(result.code).json(result);
  };

  // GET /users/v1/:id
  public getById = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await GetUserService(id);
    return res.status(result.code).json(result);
  };

  // PUT /users/v1/:id/role
  public updateRole = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { role, department, isMainAdmin } = req.body;
    const result = await UpdateUserRoleService(id, role as Role, (req as AuthenticatedRequest).user!.sub, department, isMainAdmin);
    return res.status(result.code).json(result);
  };

  // DELETE /users/v1/:id
  public delete = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const id = req.params.id as string;
    const currentAdminId = authReq.user!.sub;
    const result = await DeleteUserService(id, currentAdminId);
    return res.status(result.code).json(result);
  };

  public updateStatus = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const result = await UpdateUserStatusService(req.params.id as string, req.body.status as UserStatus, authReq.user!.sub);
    return res.status(result.code).json(result);
  };
}
