import { Request, Response } from "express";
import { JwtPayload } from "@/lib/jwt";
import {
  GetIncidentAttachmentsService,
  GetAttachmentService,
  CreateAttachmentService,
  DeleteAttachmentService,
} from "@/services/attachment";
import { GetEvidenceDeliveryService } from '@/services/attachment/get-evidence-delivery-service';

type AuthenticatedRequest = Request & { user?: JwtPayload };

export class AttachmentController {
  // GET /incidents/v1/:incidentId/attachments
  public getByIncident = async (req: Request, res: Response) => {
    const incidentId = req.params.incidentId as string;
    const result = await GetIncidentAttachmentsService(incidentId);
    return res.status(result.code).json(result);
  };

  // GET /attachments/v1/:id
  public getById = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const user = (req as AuthenticatedRequest).user!;
    const result = await GetAttachmentService(id, user.sub, user.role);
    return res.status(result.code).json(result);
  };

  // GET /attachments/v1/:id/content - authorization occurs before issuing a 60-second URL.
  public content = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const user = (req as AuthenticatedRequest).user!;
    const result = await GetEvidenceDeliveryService(id, user.sub, user.role);
    if (result.code !== 200 || !result.data) return res.status(result.code).json(result);
    return res.redirect(302, result.data.url);
  };

  // GET /attachments/v1/:id/access-url - returns a short-lived URL after authorization.
  // The cookie-authenticated frontend obtains a fresh URL before rendering it;
  // expired storage links and raw private identifiers are never persisted.
  public accessUrl = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const user = (req as AuthenticatedRequest).user!;
    const result = await GetEvidenceDeliveryService(id, user.sub, user.role);
    if (result.code !== 200 || !result.data) return res.status(result.code).json(result);
    return res.status(200).json(result);
  };

  // POST /incidents/v1/:incidentId/attachments
  public create = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const incidentId = req.params.incidentId as string;
    const uploadedBy = authReq.user!.sub;
    const result = await CreateAttachmentService(incidentId, req.body, uploadedBy);
    return res.status(result.code).json(result);
  };

  // DELETE /attachments/v1/:id
  public delete = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const id = req.params.id as string;
    const requesterId = authReq.user!.sub;
    const requesterRole = authReq.user!.role;
    const result = await DeleteAttachmentService(id, requesterId, requesterRole);
    return res.status(result.code).json(result);
  };
}
