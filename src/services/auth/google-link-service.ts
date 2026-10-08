import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import type { JwtPayload } from "@/lib/jwt";
import { ENV } from "@/config/env";
import { PasswordProcessingBusy, verifyPassword } from "@/utils/password";
import { googleLinkAuthorization, linkDigest, pkceChallenge, GOOGLE_LINK_STATE, PKCE_VERIFIER } from "./google-link-provider";

export class GoogleLinkError extends Error {
  constructor(readonly code: number, readonly reason: string, message: string) { super(message); }
}
const denied = () => new GoogleLinkError(403, "not_allowed", "Google linking is available only to active citizen accounts.");
const expired = () => new GoogleLinkError(400, "expired", "This linking attempt expired or your session changed. Confirm your password and try again.");
const conflict = () => new GoogleLinkError(409, "conflict", "Google is already connected to an account. No accounts were merged or replaced.");
const enabled = () => {
  if (!ENV.GOOGLE_ACCOUNT_LINKING_ENABLED) throw new GoogleLinkError(503, "unavailable", "Google account linking is not available yet. Email and password login still works.");
};
const citizen = (actor: JwtPayload) => { if (actor.role !== "USER" || !actor.sessionId) throw denied(); };

async function lockedCitizen(tx: Prisma.TransactionClient, actor: JwtPayload) {
  citizen(actor);
  // Same lock order as password reset/refresh: User then Token. Logout's Token
  // update also serializes with the session lock before a link commits.
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.sub} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Token" WHERE id = ${actor.sessionId!} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: actor.sub } });
  if (!user || user.status !== "ACTIVE" || user.role !== "USER") throw denied();
  const session = await tx.token.findFirst({ where: { id: actor.sessionId, userId: actor.sub,
    type: "REFRESH", consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
  if (!session) throw expired();
  return user;
}

async function passwordProof(actor: JwtPayload, password: string) {
  citizen(actor);
  const user = await prisma.user.findUnique({ where: { id: actor.sub } });
  if (!user || user.role !== "USER" || user.status !== "ACTIVE") throw denied();
  if (!user.password) throw new GoogleLinkError(409, "password_required", "Set a system password through Forgot password before changing your Google connection.");
  if (!await verifyPassword(password, user.password)) throw new GoogleLinkError(400, "wrong_password", "Your current system password is incorrect.");
  return user;
}

export async function googleLinkStatus(actor: JwtPayload) {
  citizen(actor);
  if (!ENV.GOOGLE_ACCOUNT_LINKING_ENABLED) return { available: false, linked: false, hasPassword: false };
  return prisma.$transaction(async tx => {
    const user = await lockedCitizen(tx, actor);
    const links = await tx.oAuthAccount.count({ where: { userId: user.id, provider: "google" } });
    return { available: true, linked: links > 0, hasPassword: !!user.password };
  });
}

export async function beginGoogleLink(actor: JwtPayload, password: string) {
  citizen(actor); enabled();
  const proof = await passwordProof(actor, password);
  const state = `link.${crypto.randomBytes(32).toString("base64url")}`;
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = pkceChallenge(verifier);
  const authorizationUrl = googleLinkAuthorization(state, challenge);
  await prisma.$transaction(async tx => {
    const user = await lockedCitizen(tx, actor);
    if (user.password !== proof.password || !user.email || user.email !== proof.email) throw expired();
    if (await tx.oAuthAccount.count({ where: { userId: user.id, provider: "google" } })) throw conflict();
    // One bounded row per citizen. A fresh explicit attempt supersedes old ones.
    await tx.googleLinkIntent.deleteMany({ where: { userId: user.id } });
    await tx.googleLinkIntent.create({ data: { userId: user.id, sessionId: actor.sessionId!,
      stateHash: linkDigest(state), passwordFingerprint: linkDigest(user.password!), email: user.email,
      pkceChallenge: challenge, expiresAt: new Date(Date.now() + 5 * 60_000) } });
  });
  return { state, verifier, authorizationUrl };
}

export async function claimGoogleLink(actor: JwtPayload, state: string, verifier: string) {
  citizen(actor); enabled();
  if (!GOOGLE_LINK_STATE.test(state) || !PKCE_VERIFIER.test(verifier)) throw expired();
  return prisma.$transaction(async tx => {
    const user = await lockedCitizen(tx, actor);
    const intent = await tx.googleLinkIntent.findUnique({ where: { userId: actor.sub } });
    if (!intent || intent.stateHash !== linkDigest(state) || intent.consumedAt || intent.expiresAt <= new Date() ||
        intent.sessionId !== actor.sessionId || intent.email !== user.email || !user.password ||
        intent.passwordFingerprint !== linkDigest(user.password) || intent.pkceChallenge !== pkceChallenge(verifier)) throw expired();
    const consumedAt = new Date();
    const claimed = await tx.googleLinkIntent.updateMany({ where: { id: intent.id, consumedAt: null,
      expiresAt: { gt: consumedAt } }, data: { consumedAt } });
    if (claimed.count !== 1) throw expired();
    return { id: intent.id, consumedAt };
  });
}

export async function completeGoogleLink(actor: JwtPayload, claim: { id: string; consumedAt: Date }, identity: { sub: string; email: string }) {
  citizen(actor); enabled();
  try {
    await prisma.$transaction(async tx => {
      const user = await lockedCitizen(tx, actor);
      const intent = await tx.googleLinkIntent.findUnique({ where: { id: claim.id } });
      if (!intent || intent.userId !== user.id || intent.sessionId !== actor.sessionId ||
          intent.consumedAt?.getTime() !== claim.consumedAt.getTime() || intent.expiresAt <= new Date() ||
          intent.email !== user.email || !user.password || intent.passwordFingerprint !== linkDigest(user.password)) throw expired();
      if (identity.email !== user.email?.trim().toLowerCase()) throw new GoogleLinkError(400, "email_mismatch", "Choose the verified Google account with the same email as your citizen account.");
      if (await tx.oAuthAccount.count({ where: { userId: user.id, provider: "google" } }) ||
          await tx.oAuthAccount.findUnique({ where: { provider_providerAccountId: { provider: "google", providerAccountId: identity.sub } } })) throw conflict();
      await tx.oAuthAccount.create({ data: { userId: user.id, provider: "google", providerAccountId: identity.sub } });
      await tx.googleLinkIntent.delete({ where: { id: intent.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: "GOOGLE_ACCOUNT_LINKED", entityType: "User", entityId: user.id,
        metadata: { provider: "google", method: "password-confirmed" } } });
      // No account creation, role/email-verification mutation, token issuance or
      // browser cookie replacement. The existing citizen session stays in place.
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") throw conflict();
    throw error;
  }
}

export async function unlinkGoogle(actor: JwtPayload, password: string) {
  citizen(actor); enabled();
  const proof = await passwordProof(actor, password);
  await prisma.$transaction(async tx => {
    const user = await lockedCitizen(tx, actor);
    if (user.password !== proof.password) throw expired();
    const deleted = await tx.oAuthAccount.deleteMany({ where: { userId: user.id, provider: "google" } });
    await tx.googleLinkIntent.deleteMany({ where: { userId: user.id } });
    // Password fallback is proven first. Invalidate ALL old access/refresh
    // sessions, not merely the current browser; future Google login is denied.
    await tx.token.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (deleted.count) await tx.auditLog.create({ data: { actorId: user.id, action: "GOOGLE_ACCOUNT_UNLINKED", entityType: "User", entityId: user.id,
      metadata: { provider: "google", sessionsRevoked: true } } });
  });
}

export function safeGoogleLinkError(error: unknown) {
  if (error instanceof GoogleLinkError) return { code: error.code, status: "error", errorCode: error.reason, message: error.message };
  if (error instanceof PasswordProcessingBusy) return { code: 503, status: "error", errorCode: "unavailable", message: "Password confirmation is busy. Try again shortly." };
  return { code: 503, status: "error", errorCode: "unavailable", message: "Google linking could not be completed. Try again later; your account was not merged or replaced." };
}

