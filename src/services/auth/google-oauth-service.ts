import { Profile } from "passport-google-oauth20";
import { UserRepository } from "@/repositories/user.repository";
import { OAuthAccountRepository } from "@/repositories/oauth-account.repository";
import { prisma } from "@/lib/prisma";
import { signAccessToken, signRefreshToken, TokenExpiry } from "@/lib/jwt";
import { hasValidOperationalAssignment, withPermissions } from "@/lib/permissions";
import { z } from "zod";

export async function GoogleOAuthService(profile: Profile) {
  const userRepository = new UserRepository();
  const oauthAccountRepository = new OAuthAccountRepository();

  try {
    const googleId = profile?.id;
    if (profile?.provider !== "google" || typeof googleId !== "string" || !/^[a-zA-Z0-9_-]{1,255}$/.test(googleId)) {
      return { code: 400, status: "error", message: "Invalid Google identity" };
    }
    const name = profile.displayName ?? null;

    // 1. Check if we already have an OAuthAccount for this Google ID
    const existingOAuth = await oauthAccountRepository.findByProvider("google", googleId);

    let userId: string;

    if (existingOAuth) {
      // Returning Google user — use the linked userId directly
      userId = existingOAuth.userId;
    } else {
      const email = profile.emails?.[0]?.value?.trim().toLowerCase();
      const claims = profile._json as { email?: unknown; email_verified?: unknown; hd?: unknown };
      // Passport's OpenID profile comes from Google's authenticated userinfo
      // response. Third-party email_verified alone is not current ownership.
      const verifiedEmail = (profile.emails?.[0] as { verified?: unknown } | undefined)?.verified === true;
      const hostedDomain = typeof claims?.hd === "string" ? claims.hd.trim().toLowerCase() : "";
      const authoritative = email?.endsWith("@gmail.com") ||
        (hostedDomain.length > 0 && email?.split("@")[1] === hostedDomain);
      if (!email || !z.email().safeParse(email).success || !verifiedEmail || claims?.email_verified !== true ||
          typeof claims.email !== "string" || claims.email.trim().toLowerCase() !== email || !authoritative) {
        return { code: 403, status: "error", errorCode: "oauth_email_verification_required", message: "Use email registration or a verified Gmail or Google Workspace account" };
      }
      // Email equality never grants access to an existing account (including an
      // admin), verifies it, or creates a provider link. Explicit authenticated
      // linking would need a separate step-up flow; this endpoint is sign-in only.
      if (await userRepository.findByEmail(email)) {
        return { code: 409, status: "error", errorCode: "oauth_link_required", message: "Use your existing account's email and password" };
      }
      const created = await oauthAccountRepository.createUserWithAccount({ providerAccountId: googleId, name, email });
      userId = created.userId;
    }

    // 2. Load user for role (needed to sign JWT)
    const user = await userRepository.findById(userId);
    if (!user) {
      return { code: 500, status: "error", message: "User not found after Google OAuth" };
    }
    if (user.status !== "ACTIVE") {
      return { code: 403, status: "error", message: "This account is not active" };
    }
    if (!hasValidOperationalAssignment(user)) {
      return { code: 403, status: "error", message: "This operational account has no valid department assignment" };
    }

    // Serialize issuance with unlink/reset/role changes. A lookup made before
    // unlink must not mint a fresh Google session after unlink commits.
    const issued = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: userId } });
      const binding = await tx.oAuthAccount.findUnique({ where: { provider_providerAccountId: { provider: "google", providerAccountId: googleId } } });
      if (!current || current.status !== "ACTIVE" || !hasValidOperationalAssignment(current) || binding?.userId !== userId) return null;
      const refreshToken = signRefreshToken(userId, current.role, TokenExpiry.REFRESH_TOKEN_EXPIRES);
      const session = await tx.token.create({ data: { userId, type: "REFRESH", token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } });
      return { current, refreshToken, session };
    });
    if (!issued) return { code: 403, status: "error", message: "Google connection or account access changed. Sign in again." };
    const { current, refreshToken, session } = issued;
    const accessToken = signAccessToken(userId, current.role, TokenExpiry.ACCESS_TOKEN_EXPIRES, session.id);

    return {
      code: 200,
      status: "success",
      message: "Google OAuth successful",
      data: {
        tokens: { accessToken, refreshToken },
        user: withPermissions({ id: current.id, name: current.name, email: current.email, role: current.role, department: current.department, isMainAdmin: current.isMainAdmin }),
      },
    };
  } catch (error) {
    // A concurrent sign-in must not fall back to linking by email. Nested writes
    // roll back on either unique constraint; retry the complete OAuth flow.
    if ((error as { code?: string })?.code === "P2002") {
      return { code: 409, status: "error", message: "Please retry Google sign-in" };
    }
    console.error("GoogleOAuthService failed");
    return { code: 500, status: "error", message: "Unable to process Google OAuth" };
  }
}
