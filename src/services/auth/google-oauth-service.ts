import type { Profile } from "passport-google-oauth20";
import { UserRepository } from "@/repositories/user.repository";
import { OAuthAccountRepository } from "@/repositories/oauth-account.repository";
import { prisma } from "@/lib/prisma";
import { signAccessToken, signRefreshToken, TokenExpiry } from "@/lib/jwt";
import { hasValidOperationalAssignment, withPermissions } from "@/lib/permissions";
import { googleEmail, googleSubject } from "@/lib/google-identity";

const passwordFirst = () => ({ code: 409, status: "error", errorCode: "oauth_link_password_required",
  message: "Please log in with your password first, then link Google in Settings." });
const safeAutoLink = (user: { role: string; emailVerified: Date | null; status: string }) =>
  user.role === "USER" && user.status === "ACTIVE" && !!user.emailVerified;

export async function GoogleOAuthService(profile: Profile) {
  try {
    const googleId = googleSubject(profile);
    if (!googleId) return { code: 400, status: "error", message: "Invalid Google identity" };
    const repository = new OAuthAccountRepository();
    const existing = await repository.findByProvider("google", googleId);
    const ownership = googleEmail(profile);
    let userId: string;
    let autoLink = false;
    if (existing) {
      // Stable sub, not a changed email, resolves an established identity.
      userId = existing.userId;
    } else {
      const matching = ownership.email ? await new UserRepository().findByEmail(ownership.email) : null;
      if (matching && (!ownership.authoritative || !safeAutoLink(matching))) return passwordFirst();
      if (!ownership.authoritative || !ownership.email) return { code: 403, status: "error", errorCode: "oauth_email_verification_required",
        message: "Use email registration or a verified Gmail or Google Workspace account." };
      if (matching) { userId = matching.id; autoLink = true; }
      else userId = (await repository.createUserWithAccount({ providerAccountId: googleId, name: profile.displayName ?? null, email: ownership.email })).userId;
    }

    // Lock shared with unlink, reset and refresh: a stale pre-unlink lookup must
    // never mint a fresh Google session after unlink commits.
    const issued = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: userId } });
      if (!current || current.status !== "ACTIVE" || !hasValidOperationalAssignment(current)) return null;
      let binding = await tx.authIdentity.findUnique({ where: { provider_providerUserId: { provider: "google", providerUserId: googleId } } });
      if (autoLink && !binding) {
        if (!safeAutoLink(current) || current.email?.trim().toLowerCase() !== ownership.email) return null;
        if (await tx.authIdentity.findUnique({ where: { userId_provider: { userId, provider: "google" } } })) return null;
        binding = await tx.authIdentity.create({ data: { userId, provider: "google", providerUserId: googleId, email: ownership.email } });
        await tx.auditLog.create({ data: { actorId: userId, action: "AUTH_GOOGLE_LINKED", entityType: "User", entityId: userId, metadata: { mode: "verified-citizen" } } });
        await tx.token.updateMany({ where: { userId, type: "REFRESH", revokedAt: null }, data: { revokedAt: new Date() } });
      }
      if (binding?.userId !== userId) return null;
      const refreshToken = signRefreshToken(userId, current.role, TokenExpiry.REFRESH_TOKEN_EXPIRES);
      const session = await tx.token.create({ data: { userId, type: "REFRESH", token: refreshToken, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } });
      return { current, refreshToken, session };
    });
    if (!issued) return { code: 403, status: "error", errorCode: "oauth_link_password_required", message: "Account or Google connection changed. Log in with your password and review Settings." };
    const { current, refreshToken, session } = issued;
    const accessToken = signAccessToken(userId, current.role, TokenExpiry.ACCESS_TOKEN_EXPIRES, session.id);
    return { code: 200, status: "success", message: "Signed in with Google",
      data: { tokens: { accessToken, refreshToken }, user: withPermissions({ id: current.id, name: current.name, email: current.email,
        role: current.role, department: current.department, isMainAdmin: current.isMainAdmin }) } };
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") return { code: 409, status: "error", message: "Your sign-in methods changed. Please retry Google sign-in." };
    console.error("Google sign-in unavailable; no provider or account details logged");
    return { code: 503, status: "error", message: "Google sign-in is temporarily unavailable. Please try again." };
  }
}
