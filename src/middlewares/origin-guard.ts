import type { Request, Response, NextFunction } from "express";
import { ENV } from "@/config/env";

const trustedOrigins = new Set([ENV.FRONTEND_URL, ENV.BACKEND_URL].map((url) => new URL(url).origin));
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/** CORS does not stop a cross-site HTML form from sending a cookie-authenticated POST. */
export function originGuard(req: Request, res: Response, next: NextFunction) {
  if (safeMethods.has(req.method) || !req.path.startsWith("/api/")) return next();
  const origin = req.get("origin");
  const referer = req.get("referer");
  let claimedOrigin = origin;
  if (!claimedOrigin && referer) {
    try { claimedOrigin = new URL(referer).origin; } catch { claimedOrigin = "invalid"; }
  }
  if ((claimedOrigin && !trustedOrigins.has(claimedOrigin))
    || (!claimedOrigin && req.get("sec-fetch-site") === "cross-site")) {
    return res.status(403).json({ code: 403, status: "error", message: "Request origin is not allowed" });
  }
  return next();
}
