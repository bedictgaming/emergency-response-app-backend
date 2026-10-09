import { Request, Response } from "express";
import { Profile } from "passport-google-oauth20";
import { SignupUserService, LoginCredentialsService, RefreshTokenService, GetMeService, GoogleOAuthService, RequestPasswordResetService, ResetPasswordService } from "@/services/auth";
import { TokenExpiry, toMilliseconds, verifyAccessToken, type JwtPayload } from "@/lib/jwt";
import { ENV } from "@/config/env";
import { prisma } from "@/lib/prisma";

export class AuthController {
  // A scheduling hint only, never a credential or an authorization input.
  // Outlive the access cookie so a tab returning from sleep can renew first.
  private setRenewalHint(res: Response, expiresAt: number) {
    res.cookie("sessionRenewAt", String(expiresAt - 120_000), {
      httpOnly: false,
      secure: ENV.NODE_ENV === "production",
      sameSite: ENV.NODE_ENV === "production" ? "none" : "lax",
      domain: ENV.COOKIE_DOMAIN,
      maxAge: toMilliseconds(TokenExpiry.REFRESH_TOKEN_EXPIRES),
    });
  }

  // Helper to set cookies
  private setAuthCookies(
    res: Response,
    tokens: { accessToken: string; refreshToken: string },
  ) {
    const isProduction = ENV.NODE_ENV === "production";
    const domain = ENV.COOKIE_DOMAIN;

    res.cookie("accessToken", tokens.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      domain,
      maxAge: toMilliseconds(TokenExpiry.ACCESS_TOKEN_EXPIRES),
    });

    res.cookie("refreshToken", tokens.refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      domain,
      maxAge: toMilliseconds(TokenExpiry.REFRESH_TOKEN_EXPIRES),
    });
    const expiry = verifyAccessToken(tokens.accessToken)?.exp;
    this.setRenewalHint(res, expiry ? expiry * 1000 : Date.now() + toMilliseconds(TokenExpiry.ACCESS_TOKEN_EXPIRES)!);
  }

  // Credentials Signup
  public signup = async (req: Request, res: Response) => {
    const { name, email, password } = req.body ?? {};
    const result = await SignupUserService(name, email, password);
    return res.status(result.code).json(result);
  };

  public requestPasswordReset = async (req: Request, res: Response) => {
    const result = await RequestPasswordResetService(req.body.email);
    return res.status(result.code).json(result);
  };

  public resetPassword = async (req: Request, res: Response) => {
    const result = await ResetPasswordService(req.body.token, req.body.password);
    return res.status(result.code).json(result);
  };

  // Handle Login Account
  public login = async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    const result = await LoginCredentialsService(email, password);
    
    if (result.code === 200 && result.data?.tokens) {
      this.setAuthCookies(res, result.data.tokens);
      return res.status(200).json({ code: 200, status: "success", message: result.message, data: { user: result.data.user } });
    }

    return res.status(result.code).json(result);
  };

  // Refresh Token Helps Generate another valid Access Token
  public refresh = async (req: Request, res: Response) => {
    const refreshToken = req.body?.refreshToken || req.cookies?.refreshToken;
    const result = await RefreshTokenService(refreshToken);

    if (result.code === 200 && result.data?.tokens) {
      this.setAuthCookies(res, result.data.tokens);
      return res.status(200).json({ code: 200, status: "success", message: result.message, data: { user: result.data.user } });
    }

    return res.status(result.code).json(result);
  };

  // Handle Logout
  public logout = async (req: Request, res: Response) => {
    const domain = ENV.COOKIE_DOMAIN;
    const refresh = req.cookies?.refreshToken || req.body?.refreshToken;
    if (typeof refresh === "string") await prisma.token.updateMany({ where: { token: refresh, type: "REFRESH", revokedAt: null }, data: { revokedAt: new Date() } });

    res.clearCookie("accessToken", { domain });
    res.clearCookie("refreshToken", { domain });
    res.clearCookie("sessionRenewAt", { domain });
    return res.status(200).json({ code: 200, status: "success", message: "Logged out successfully" });
  };

  // Google OAuth Callback
  public googleCallback = async (req: Request, res: Response) => {
    const profile = req.user as Profile;
    const result = await GoogleOAuthService(profile);

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    if (result.code === 200 && result.data?.tokens) {
      this.setAuthCookies(res, result.data.tokens);
        // Authentication is carried by secure HttpOnly cookies. Never put an
        // access token in URLs, browser history, analytics, or server logs.
        return res.redirect(`${frontendUrl}/login?oauth=success`);
    }

    const reason = result.errorCode === "oauth_link_required" || result.errorCode === "oauth_email_verification_required"
      ? result.errorCode : "oauth_failed";
    return res.redirect(`${frontendUrl}/login?oauth=${reason}`);
  };

  // Get Current User Session
  public me = async (req: Request, res: Response) => {
    const account = req.user as JwtPayload | undefined;
    if (!account?.sub) return res.status(401).json({ code: 401, status: "error", message: "Authentication required" });
    const result = await GetMeService(account.sub);
    // Bootstrap existing valid sessions without rotating on every page load.
    // Once present, do not reset it on every profile read.
    if (result.code === 200 && account?.exp && !req.cookies?.sessionRenewAt) {
      this.setRenewalHint(res, account.exp * 1000);
    }
    return res.status(result.code).json(result);
  };

}
