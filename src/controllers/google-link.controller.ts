import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { JwtPayload } from "@/lib/jwt";
import { ENV } from "@/config/env";
import { beginGoogleLink, claimGoogleLink, completeGoogleLink, googleLinkStatus, unlinkGoogle, safeGoogleLinkError } from "@/services/auth/google-link-service";
import { exchangeGoogleLinkCode, GOOGLE_LINK_STATE } from "@/services/auth/google-link-provider";

const actor = (req: Request) => req.user as JwtPayload;
const linkCookie = { httpOnly: true, secure: ENV.NODE_ENV === "production", sameSite: "lax" as const,
  path: "/api/auth/v1/google", maxAge: 5 * 60_000 };
const clearLinkCookies = (res: Response) => {
  for (const name of ["google_link_state", "google_link_verifier"]) res.clearCookie(name, { ...linkCookie, maxAge: undefined });
};
const redirect = (res: Response, result: string) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  return res.redirect(`${ENV.FRONTEND_URL.replace(/\/+$/, "")}/dashboard?googleLink=${result}`);
};

export class GoogleLinkController {
  status = async (req: Request, res: Response) => {
    try { return res.json({ code: 200, status: "success", data: await googleLinkStatus(actor(req)) }); }
    catch (error) { const result = safeGoogleLinkError(error); return res.status(result.code).json(result); }
  };
  begin = async (req: Request, res: Response) => {
    clearLinkCookies(res);
    try {
      const result = await beginGoogleLink(actor(req), req.body.password);
      res.cookie("google_link_state", result.state, linkCookie);
      res.cookie("google_link_verifier", result.verifier, linkCookie);
      return res.json({ code: 200, status: "success", data: { authorizationUrl: result.authorizationUrl } });
    } catch (error) { const result = safeGoogleLinkError(error); return res.status(result.code).json(result); }
  };
  unlink = async (req: Request, res: Response) => {
    try {
      await unlinkGoogle(actor(req), req.body.password);
      clearLinkCookies(res);
      for (const name of ["accessToken", "refreshToken", "sessionRenewAt"]) res.clearCookie(name, { domain: ENV.COOKIE_DOMAIN });
      return res.json({ code: 200, status: "success", message: "Google disconnected and all sessions signed out. Log in with your system password." });
    } catch (error) { const result = safeGoogleLinkError(error); return res.status(result.code).json(result); }
  };
  // State is explicitly namespaced: this callback cannot fall through to login
  // or create a new account after a failed link. No extra Google redirect URI.
  callback = async (req: Request, res: Response, _next?: NextFunction) => {
    const expected = req.cookies?.google_link_state;
    const verifier = req.cookies?.google_link_verifier;
    const state = req.query.state;
    clearLinkCookies(res);
    if (typeof state !== "string" || !GOOGLE_LINK_STATE.test(state) || typeof expected !== "string" || !GOOGLE_LINK_STATE.test(expected) ||
        expected.length !== state.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(state)) || typeof verifier !== "string") {
      return redirect(res, "expired");
    }
    try {
      // Claim before contacting Google so concurrent/replayed callbacks cannot
      // repeat the exchange. Denial/cancellation also consumes the intent.
      const claim = await claimGoogleLink(actor(req), state, verifier);
      if (req.query.error) return redirect(res, "cancelled");
      if (typeof req.query.code !== "string" || req.query.code.length < 1 || req.query.code.length > 2048) return redirect(res, "failed");
      const identity = await exchangeGoogleLinkCode(req.query.code, verifier);
      await completeGoogleLink(actor(req), claim, identity);
      return redirect(res, "linked");
    } catch (error) {
      const reason = safeGoogleLinkError(error).errorCode;
      return redirect(res, ["expired", "email_mismatch", "conflict", "not_allowed"].includes(reason) ? reason : "failed");
    }
  };
}

