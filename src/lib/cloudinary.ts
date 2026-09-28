import { v2 as cloudinary } from "cloudinary";
import { ENV } from "@/config/env";
import crypto from "node:crypto";

// Initialize Cloudinary with env credentials
cloudinary.config({
  cloud_name: ENV.CLOUDINARY.CLOUD_NAME,
  api_key: ENV.CLOUDINARY.API_KEY,
  api_secret: ENV.CLOUDINARY.API_SECRET,
  secure: true,
});

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_FORMATS = new Set(["jpg", "jpeg", "png", "webp", "heic"]);

export interface CloudinaryUploadResult {
  url: string;
  publicId: string;
  format: string;
  bytes: number;
  width: number;
  height: number;
}

export interface VerifiedCloudinaryAsset extends CloudinaryUploadResult {
  phash?: string;
  moderationStatus?: string;
}

const RESOURCE_LOOKUP_RETRY_DELAYS_MS = [250, 500, 1_000];

function isCloudinaryResourceNotFound(error: unknown): boolean {
  const cloudinaryError = error as {
    error?: { http_code?: number; message?: string };
    http_code?: number;
    message?: string;
  };
  const status = cloudinaryError.error?.http_code ?? cloudinaryError.http_code;
  const message = cloudinaryError.error?.message ?? cloudinaryError.message ?? "";
  return status === 404 || /resource not found/i.test(message);
}

async function readUploadedAsset(publicId: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await cloudinary.api.resource(publicId, {
        resource_type: "image",
        type: "authenticated",
        phash: true,
      });
    } catch (error) {
      const retryDelay = RESOURCE_LOOKUP_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isCloudinaryResourceNotFound(error)) throw error;

      // Cloudinary's upload response can reach the browser just before the
      // Admin API index becomes consistent. Retry that narrow 404 window so
      // a valid proof photo is not rejected and uploaded again by the user.
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

export function generateUploadSignature(userId: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `emergency-incidents/${userId}`;
  const publicId = crypto.randomUUID();
  // resource_type belongs to the URL and must not be included in the signature.
  // A signed public_id plus overwrite=false makes the signature usable for only
  // one stored asset, even if a client replays it before its timestamp expires.
  const params = { timestamp, folder, public_id: publicId, overwrite: false, type: "authenticated" as const, allowed_formats: "jpg,jpeg,png,webp,heic" };
  const signature = cloudinary.utils.api_sign_request(params, ENV.CLOUDINARY.API_SECRET);
  return { ...params, publicId, signature, apiKey: ENV.CLOUDINARY.API_KEY, cloudName: ENV.CLOUDINARY.CLOUD_NAME };
}

export async function verifyUploadedAsset(publicId: string, userId: string): Promise<VerifiedCloudinaryAsset> {
  const asset = await readUploadedAsset(publicId);
  if (!asset.public_id.startsWith(`emergency-incidents/${userId}/`)) {
    throw new Error("Uploaded asset does not belong to this user");
  }
  if (!ALLOWED_FORMATS.has(String(asset.format).toLowerCase())) throw new Error("Unsupported image format");
  if (Number(asset.bytes) > 8 * 1024 * 1024) throw new Error("Image exceeds the 8 MB limit");
  return {
    url: asset.secure_url,
    publicId: asset.public_id,
    format: asset.format,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    phash: asset.phash,
    moderationStatus: asset.moderation?.[0]?.status,
  };
}

/**
 * Validates and uploads a base64-encoded image to Cloudinary.
 * @param base64DataUrl - "data:image/jpeg;base64,..." string
 * @param folder - Cloudinary folder to place the image in
 */
export const uploadImage = async (
  base64DataUrl: string,
  folder = "emergency-incidents"
): Promise<CloudinaryUploadResult> => {
  // 1. Validate that the string looks like a base64 data URL
  const mimeMatch = base64DataUrl.match(/^data:([^;]+);base64,/);
  if (!mimeMatch) {
    throw new Error("Invalid image format. Must be a base64-encoded data URL.");
  }

  const mimeType = mimeMatch[1].toLowerCase();
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new Error(
      `Unsupported file type: ${mimeType}. Only JPEG, PNG, and WEBP images are allowed.`
    );
  }

  // 2. Validate file size from base64 data
  const base64Data = base64DataUrl.split(",")[1];
  const estimatedBytes = Math.ceil((base64Data.length * 3) / 4);
  if (estimatedBytes > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File too large (${(estimatedBytes / 1024 / 1024).toFixed(1)}MB). Maximum allowed size is 10MB.`
    );
  }

  // 3. Upload to Cloudinary
  const result = await cloudinary.uploader.upload(base64DataUrl, {
    folder,
    resource_type: "image",
    type: "authenticated",
    // Auto-tag for moderation & organization
    tags: ["incident-evidence", "emergency-report"],
    // Auto-optimize for web delivery
    quality: "auto",
    fetch_format: "auto",
    // Generate a timestamped public_id for traceability
    unique_filename: true,
    overwrite: false,
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    format: result.format,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
  };
};

/**
 * Deletes an image from Cloudinary by its publicId.
 */
export const deleteImage = async (publicId: string): Promise<void> => {
  const result = await cloudinary.uploader.destroy(publicId, { type: "authenticated", invalidate: true });
  if (!["ok", "not found"].includes(result.result)) throw new Error("Image deletion was not confirmed");
};

export const createEvidenceDownloadUrl = (publicId: string, format: string): string =>
  cloudinary.utils.private_download_url(publicId, format, {
    resource_type: "image",
    type: "authenticated",
    expires_at: Math.floor(Date.now() / 1000) + 60,
    attachment: false,
  });

export async function migrateImageToAuthenticated(publicId: string) {
  return cloudinary.uploader.rename(publicId, publicId, {
    resource_type: "image",
    type: "upload",
    to_type: "authenticated",
    overwrite: true,
    invalidate: true,
  });
}

export default cloudinary;
