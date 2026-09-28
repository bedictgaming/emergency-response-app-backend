import { Request, Response } from "express";
import { JwtPayload } from "@/lib/jwt";
import {
  GetIncidentAttachmentsService,
  GetAttachmentService,
  CreateAttachmentService,
  DeleteAttachmentService,
} from "@/services/attachment";
import { createEvidenceDownloadUrl } from "@/lib/cloudinary";

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
    const result = await GetAttachmentService(id, user.sub, user.role);
    if (result.code !== 200 || !result.data) return res.status(result.code).json(result);
    const attachment = result.data.attachment as unknown as { publicId?: string; format?: string };
    // Fetch the private storage identifiers only after the service-level ownership check.
    const record = await (await import("@/lib/prisma")).prisma.attachment.findUnique({
      where: { attachmentId: id }, select: { publicId: true, format: true },
    });
    if (!record?.publicId || !record.format) return res.status(404).json({ code: 404, status: "error", message: "Evidence asset is unavailable" });
    return res.redirect(302, createEvidenceDownloadUrl(record.publicId, record.format));
  };

  // GET /attachments/v1/:id/access-url - returns a short-lived URL after authorization.
  // Browser <img> elements cannot attach our Bearer token, so the frontend first
  // calls this authenticated endpoint and then renders the temporary storage URL.
  public accessUrl = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const user = (req as AuthenticatedRequest).user!;
    const result = await GetAttachmentService(id, user.sub, user.role);
    if (result.code !== 200 || !result.data) return res.status(result.code).json(result);

    const record = await (await import("@/lib/prisma")).prisma.attachment.findUnique({
      where: { attachmentId: id },
      select: { publicId: true, format: true },
    });
    if (!record?.publicId || !record.format) {
      return res.status(404).json({ code: 404, status: "error", message: "Evidence asset is unavailable" });
    }

    return res.status(200).json({
      code: 200,
      status: "success",
      data: {
        url: createEvidenceDownloadUrl(record.publicId, record.format),
        expiresInSeconds: 60,
      },
    });
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
