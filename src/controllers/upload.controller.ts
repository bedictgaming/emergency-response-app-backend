import { Request, Response } from "express";
import { uploadImage, generateUploadSignature } from "@/lib/cloudinary";
import { JwtPayload } from "@/lib/jwt";
import { consumePhotoUploadAllowance } from "@/lib/upload-quota";
import { evidenceFolder } from '@/lib/evidence-scope';

type AuthenticatedRequest = Request & { user?: JwtPayload };

const MAX_BASE64_SIZE = 3.5 * 1024 * 1024; // bounded 2.5MB-photo fallback

export class UploadController {
  public signature = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user!.sub;
    const allowed = await consumePhotoUploadAllowance(userId, req.ip);
    if (!allowed) return res.status(429).json({ code: 429, status: "error", message: "Photo upload limit reached. Try again later." });
    return res.status(200).json({
      code: 200,
      status: "success",
      data: generateUploadSignature(userId),
    });
  };
  /**
   * POST /upload/v1/image
   * Receives a base64-encoded image, validates it server-side, uploads to Cloudinary.
   * Returns the secure public URL.
   */
  public uploadImage = async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;

    try {
      const { imageData, fileName } = req.body as {
        imageData?: string;
        fileName?: string;
      };

      // --- Validation ---
      if (!imageData) {
        return res.status(400).json({
          code: 400,
          status: "error",
          message: "Missing image data. Please provide a base64-encoded image.",
        });
      }

      if (typeof imageData !== "string") {
        return res.status(400).json({
          code: 400,
          status: "error",
          message: "imageData must be a base64-encoded string.",
        });
      }

      // Reject oversized payloads early
      if (imageData.length > MAX_BASE64_SIZE) {
        return res.status(413).json({
          code: 413,
          status: "error",
          message: "The secure fallback accepts photos under 2.5MB. Use direct upload for photos up to 5MB.",
        });
      }

      // Validate base64 data URL format
      const mimeMatch = imageData.match(/^data:([^;]+);base64,/);
      if (!mimeMatch) {
        return res.status(400).json({
          code: 400,
          status: "error",
          message:
            "Invalid image format. imageData must be a valid base64 data URL (e.g. data:image/jpeg;base64,...).",
        });
      }

      const mimeType = mimeMatch[1].toLowerCase();
      const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
      if (!allowedTypes.includes(mimeType)) {
        return res.status(415).json({
          code: 415,
          status: "error",
          message: `Unsupported file type: ${mimeType}. Only JPEG, PNG, and WEBP images are accepted to prevent false reports.`,
        });
      }

      if (!await consumePhotoUploadAllowance(authReq.user!.sub, req.ip)) {
        return res.status(429).json({ code: 429, status: "error", message: "Photo upload limit reached. Try again later." });
      }

      // --- Upload to Cloudinary ---
      const result = await uploadImage(imageData, evidenceFolder(authReq.user!.sub));

      console.log(
        `[Upload] Incident photo uploaded (${(result.bytes / 1024).toFixed(0)}KB)`
      );

      return res.status(200).json({
        code: 200,
        status: "success",
        message: "Image uploaded successfully",
        data: {
          url: result.url,
          publicId: result.publicId,
          format: result.format,
          bytes: result.bytes,
          width: result.width,
          height: result.height,
          fileName: fileName || `incident-${Date.now()}`,
        },
      });
    } catch (error: unknown) {
      const err = error as Error;
      console.error("[UploadController] Error:", err.message);

      // Return validation errors with 400, server errors with 500
      const isValidationError =
        err.message.includes("Unsupported") ||
        err.message.includes("Invalid") ||
        err.message.includes("too large");

      return res.status(isValidationError ? 400 : 500).json({
        code: isValidationError ? 400 : 500,
        status: "error",
        message: isValidationError
          ? err.message
          : "Failed to upload image. Please try again.",
      });
    }
  };
}
