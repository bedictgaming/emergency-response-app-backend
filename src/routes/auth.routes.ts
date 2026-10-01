import { Router } from "express";
import { AuthController } from "@/controllers/auth.controller";
import { validateSchema } from "@/middlewares/validate.schema";
import { signupSchema, loginSchema, verifyEmailSchema, resendVerificationSchema, refreshTokenSchema, requestPasswordResetSchema, resetPasswordSchema } from "@/schema/auth";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import passport from "@/lib/passport";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { ENV } from "@/config/env";
import { clientIpRateLimitKey } from "@/middlewares/api-gateway";

// Initialize
const router = Router();
const authController = new AuthController();
const authMiddleware = new AuthMiddleware();

const authAttemptLimiter = rateLimit({
  keyGenerator: clientIpRateLimitKey,
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { code: 429, status: "error", message: "Too many failed authentication attempts. Try again later." },
});

const accountMessageLimiter = rateLimit({
  keyGenerator: clientIpRateLimitKey,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { code: 429, status: "error", message: "Too many account-message requests. Try again later." },
});

const tokenRefreshLimiter = rateLimit({
  keyGenerator: clientIpRateLimitKey,
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { code: 429, status: "error", message: "Too many token refresh attempts. Try again later." },
});

const googleOAuthLimiter = rateLimit({
  keyGenerator: clientIpRateLimitKey,
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { code: 429, status: "error", message: "Too many Google sign-in attempts. Try again later." },
});

// Authentication Routes
router.post("/v1/signup", authAttemptLimiter, validateSchema(signupSchema), authController.signup);
router.post("/v1/login", authAttemptLimiter, validateSchema(loginSchema), authController.login);
router.get("/v1/verify-email", validateSchema(verifyEmailSchema), authController.verifyEmail);
router.post("/v1/resend-email-verification", accountMessageLimiter, validateSchema(resendVerificationSchema), authController.resendEmailVerification);
router.post("/v1/refresh-token", tokenRefreshLimiter, validateSchema(refreshTokenSchema), authController.refresh);
router.post("/v1/logout", authController.logout);
router.post("/v1/password-reset/request", accountMessageLimiter, validateSchema(requestPasswordResetSchema), authController.requestPasswordReset);
router.post("/v1/password-reset/confirm", authAttemptLimiter, validateSchema(resetPasswordSchema), authController.resetPassword);

// Google OAuth uses a one-time, HttpOnly state cookie to prevent login CSRF.
const oauthCookie = {
  httpOnly: true,
  secure: ENV.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 10 * 60 * 1000,
  path: "/api/auth/v1/google",
};
router.get("/v1/google", googleOAuthLimiter, (req, res, next) => {
  const state = crypto.randomBytes(32).toString("base64url");
  res.cookie("google_oauth_state", state, oauthCookie);
  return passport.authenticate("google", { scope: ["profile", "email"], state })(req, res, next);
});
router.get("/v1/google/callback", (req, res, next) => {
  const expected = req.cookies?.google_oauth_state as string | undefined;
  const received = typeof req.query.state === "string" ? req.query.state : undefined;
  res.clearCookie("google_oauth_state", { ...oauthCookie, maxAge: undefined });
  const valid = Boolean(expected && received && expected.length === received.length
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received)));
  if (!valid) return res.status(400).json({ code: 400, status: "error", message: "Invalid or expired Google sign-in state" });
  return passport.authenticate("google", { session: false })(req, res, next);
}, authController.googleCallback);

// Session Verification
router.get("/v1/me", authMiddleware.execute, authController.me);

export default router;
