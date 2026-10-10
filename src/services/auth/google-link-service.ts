import crypto from "node:crypto";
import type { Profile } from "passport-google-oauth20";
import type { Prisma, GoogleLinkIntent } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { ENV } from "@/config/env";
import type { JwtPayload } from "@/lib/jwt";
import { hasValidOperationalAssignment } from "@/lib/permissions";
import { googleEmail, googleSubject } from "@/lib/google-identity";
import { verifyPassword, PasswordProcessingBusy } from "@/utils/password";

type Actor = Pick<JwtPayload, "sub" | "sessionId">;
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const challenge = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");
const failure = (code: number, message: string) => ({ code, status: "error" as const, message });
const stale = () => failure(409, "Your session or sign-in methods changed. Reload Settings and try again.");

async function lockedAccount(tx: Prisma.TransactionClient, actor: Actor) {
  if (!actor.sessionId) return null;
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.sub} FOR UPDATE`;
  // Logout revokes the Token row directly. Hold it until the identity mutation
  // commits, so a logout that wins this lock is observed before any linking.
  await tx.$queryRaw`SELECT id FROM "Token" WHERE id = ${actor.sessionId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: actor.sub }, include: {
    authIdentities: true,
    tokens: { where: { id: actor.sessionId, type: "REFRESH", consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } },
  } });
  return user && user.status === "ACTIVE" && hasValidOperationalAssignment(user) && user.tokens.length === 1 ? user : null;
}

async function passwordProof(actor: Actor, password: string) {
  const user = await prisma.user.findUnique({ where: { id: actor.sub } });
  if (!user?.password || !await verifyPassword(password, user.password)) return null;
  return user.password;
}

async function secureMutation(tx: Prisma.TransactionClient, userId: string, sessionId: string, action: string) {
  await tx.token.updateMany({ where: { userId, type: "REFRESH", id: { not: sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
  await tx.auditLog.create({ data: { actorId: userId, action, entityType: "User", entityId: userId, metadata: { mode: "password-confirmed" } } });
}

export async function GetLoginMethodsService(actor: Actor) {
  try {
    return await prisma.$transaction(async tx => {
      const user = await lockedAccount(tx, actor);
      if (!user) return failure(401, "Please log in again to view Settings.");
      const google = user.authIdentities.find(identity => identity.provider === "google");
      const password = !!user.password && user.authIdentities.some(identity => identity.provider === "password" && identity.providerUserId === user.id);
      return { code: 200, status: "success", data: { accountId: user.id, password, google: google ? { connected: true, email: google.email } : { connected: false, email: null },
        canUnlinkGoogle: !!google && password } };
    });
  } catch { return failure(503, "Sign-in methods are temporarily unavailable. Please retry."); }
}

export async function BeginGoogleLinkService(actor: Actor, password: string) {
  try {
    const proof = await passwordProof(actor, password);
    if (!proof) return failure(403, "Your current password was not confirmed. Try again or use Forgot password.");
    const state = `link.${crypto.randomBytes(32).toString("base64url")}`;
    const verifier = crypto.randomBytes(32).toString("base64url");
    const result = await prisma.$transaction(async tx => {
      const user = await lockedAccount(tx, actor);
      if (!user || user.password !== proof || !user.email) return stale();
      if (user.authIdentities.some(identity => identity.provider === "google")) return failure(409, "Google is already connected. Reload Settings to see your sign-in methods.");
      await tx.googleLinkIntent.upsert({ where: { userId: user.id }, create: {
        userId: user.id, sessionId: actor.sessionId!, stateHash: digest(state), passwordFingerprint: digest(proof), email: user.email,
        pkceChallenge: challenge(verifier), expiresAt: new Date(Date.now() + 5 * 60_000),
      }, update: {
        sessionId: actor.sessionId!, stateHash: digest(state), passwordFingerprint: digest(proof), email: user.email,
        pkceChallenge: challenge(verifier), expiresAt: new Date(Date.now() + 5 * 60_000), consumedAt: null,
      } });
      return { code: 200, status: "success" as const };
    });
    if (result.code !== 200) return result;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: ENV.GOOGLE_CLIENT_ID!, redirect_uri: `${ENV.BACKEND_URL}/api/auth/v1/google/callback`,
      response_type: "code", scope: "openid profile email", state, prompt: "select_account", code_challenge: challenge(verifier), code_challenge_method: "S256" }).toString();
    // Only authorizationUrl goes to JSON. State + verifier go to HttpOnly cookies.
    return { code: 200, status: "success" as const, data: { authorizationUrl: url.toString() }, state, verifier };
  } catch (error) {
    if (error instanceof PasswordProcessingBusy) return failure(503, "Password confirmation is busy. Please try again shortly.");
    return failure(503, "Google connection could not start. Please retry from Settings.");
  }
}

// Claim before exchanging the code: even a copied old cookie cannot replay an intent.
export async function ClaimGoogleLinkService(actor: Actor, state: string, verifier: string): Promise<GoogleLinkIntent | null> {
  if (!/^link\.[a-zA-Z0-9_-]{43}$/.test(state) || !/^[a-zA-Z0-9_-]{43}$/.test(verifier)) return null;
  return prisma.$transaction(async tx => {
    const user = await lockedAccount(tx, actor);
    if (!user?.password) return null;
    const intent = await tx.googleLinkIntent.findUnique({ where: { stateHash: digest(state) } });
    if (!intent || intent.userId !== user.id || intent.sessionId !== actor.sessionId || intent.consumedAt || intent.expiresAt <= new Date()
      || intent.passwordFingerprint !== digest(user.password) || intent.email !== user.email || intent.pkceChallenge !== challenge(verifier)) return null;
    const consumedAt = new Date();
    const claim = await tx.googleLinkIntent.updateMany({ where: { id: intent.id, stateHash: intent.stateHash, consumedAt: null, expiresAt: { gt: consumedAt } }, data: { consumedAt } });
    return claim.count === 1 ? { ...intent, consumedAt } : null;
  });
}

export async function CompleteGoogleLinkService(actor: Actor, intent: GoogleLinkIntent, profile: Profile) {
  try {
    const sub = googleSubject(profile);
    const ownership = googleEmail(profile);
    if (!sub || !ownership.authoritative || ownership.email !== intent.email.trim().toLowerCase())
      return failure(403, "Choose the verified Gmail or Google Workspace account with the same email as this account.");
    return await prisma.$transaction(async tx => {
      const user = await lockedAccount(tx, actor);
      const current = await tx.googleLinkIntent.findUnique({ where: { userId: actor.sub } });
      if (!user?.password || user.id !== intent.userId || actor.sessionId !== intent.sessionId || !current?.consumedAt
        || current.stateHash !== intent.stateHash || current.expiresAt <= new Date() || user.email !== intent.email || digest(user.password) !== intent.passwordFingerprint) return stale();
      const binding = await tx.authIdentity.findUnique({ where: { provider_providerUserId: { provider: "google", providerUserId: sub } } });
      if (binding && binding.userId !== user.id) return failure(409, "This Google account is connected to another account. No accounts were merged.");
      if (user.authIdentities.some(identity => identity.provider === "google")) return stale();
      await tx.authIdentity.create({ data: { userId: user.id, provider: "google", providerUserId: sub, email: ownership.email } });
      // Do not mark emailVerified: linking does not certify an operational account.
      await secureMutation(tx, user.id, actor.sessionId!, "AUTH_GOOGLE_LINKED");
      return { code: 200, status: "success", message: "Google connected. You can now use either sign-in method. Other sessions were signed out." };
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") return stale();
    return failure(503, "Google was not connected. Please retry from Settings.");
  }
}

export async function UnlinkGoogleService(actor: Actor, password: string) {
  try {
    const proof = await passwordProof(actor, password);
    if (!proof) return failure(403, "A confirmed password is required. You cannot remove your only sign-in method.");
    return await prisma.$transaction(async tx => {
      const user = await lockedAccount(tx, actor);
      if (!user || user.password !== proof) return stale();
      const passwordMethod = user.authIdentities.some(identity => identity.provider === "password" && identity.providerUserId === user.id);
      if (!passwordMethod || !user.password) return failure(409, "Google is your only sign-in method. Set a password with Forgot password before disconnecting it.");
      const removed = await tx.authIdentity.deleteMany({ where: { userId: user.id, provider: "google" } });
      if (removed.count !== 1) return stale();
      await tx.googleLinkIntent.deleteMany({ where: { userId: user.id } });
      await secureMutation(tx, user.id, actor.sessionId!, "AUTH_GOOGLE_UNLINKED");
      return { code: 200, status: "success", message: "Google disconnected. Use your email and password next time. Other sessions were signed out." };
    });
  } catch (error) {
    if (error instanceof PasswordProcessingBusy) return failure(503, "Password confirmation is busy. Please try again shortly.");
    return failure(503, "Google could not be disconnected. Reload Settings to check your sign-in methods.");
  }
}
