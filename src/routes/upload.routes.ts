import { Router } from "express";
import { UploadController } from "@/controllers/upload.controller";
import { AuthMiddleware } from "@/middlewares/auth-middleware";

const router = Router();
const uploadController = new UploadController();
const authMiddleware = new AuthMiddleware();

router.post("/v1/signature", authMiddleware.execute, uploadController.signature);

// POST /upload/v1/image — authenticated, uploads base64 image to Cloudinary
router.post("/v1/image", authMiddleware.execute, uploadController.uploadImage);

export default router;
