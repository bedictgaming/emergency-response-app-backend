import { Router } from "express";
import { AttachmentController } from "@/controllers/attachment.controller";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { requireAttachmentDepartment } from "@/middlewares/operational-access-middleware";

// Initialize
const router = Router();
const attachmentController = new AttachmentController();
const authMiddleware = new AuthMiddleware();

// Authenticated Routes
router.get("/v1/:id", authMiddleware.execute, requireAttachmentDepartment, attachmentController.getById);
router.get("/v1/:id/content", authMiddleware.execute, requireAttachmentDepartment, attachmentController.content);
router.get("/v1/:id/access-url", authMiddleware.execute, requireAttachmentDepartment, attachmentController.accessUrl);
router.delete("/v1/:id", authMiddleware.execute, requireAttachmentDepartment, attachmentController.delete);

export default router;
