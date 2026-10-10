import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ENV } from "@/config/env";
import { TokenType } from "@/generated/prisma";
import { hashPassword, PasswordProcessingBusy } from "@/utils/password";
import { sendEmail } from "@/services/mail/mailer";
import { mailFailureCategory } from "@/services/mail/mail-errors";

const digest = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const invalid = () => ({ code: 400, status: "error", message: "Invalid or expired password-reset token" });

export async function RequestPasswordResetService(email: string) {
  try {
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (user?.email && user.status === "ACTIVE") {
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await prisma.token.create({
        data: { userId: user.id, type: TokenType.PASSWORD_RESET, token: digest(token), expiresAt },
      });
      const resetUrl = `${ENV.FRONTEND_URL.replace(/\/+$/, "")}/login?resetToken=${encodeURIComponent(token)}`;
      await sendEmail({
        to: user.email,
        subject: "Reset your Emergency Response password",
        accountAction: { purpose: "RESET_PASSWORD", url: resetUrl, name: user.name ?? "there", expiresAt: expiresAt.toISOString() },
        html: `<p>A password reset was requested for your account.</p><p><a href="${resetUrl}">Reset password</a></p><p>This link expires in 30 minutes.</p>`,
      });
    }
  } catch (error) {
    // Provider/database failures must not disclose whether an account exists.
    console.error("Password reset request unavailable", { category: mailFailureCategory(error) });
  }
  return { code: 202, status: "success", message: "If an eligible account exists, password-reset delivery has been requested. Check your inbox and spam folder." };
}

export async function ResetPasswordService(token: string, password: string) {
  try {
    const stored = await prisma.token.findFirst({
      where: { token: digest(token), type: TokenType.PASSWORD_RESET, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!stored) return invalid();
    const hashed = await hashPassword(password);
    const consumed = await prisma.$transaction(async (tx) => {
      // Serialize resets with session rotation; claim again after taking the lock.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${stored.userId} FOR UPDATE`;
      const claim = await tx.token.updateMany({
        where: { id: stored.id, type: TokenType.PASSWORD_RESET, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (claim.count !== 1) return false;
      await tx.user.update({ where: { id: stored.userId }, data: { password: hashed } });
      const account = await tx.user.findUnique({ where: { id: stored.userId }, select: { email: true } });
      await tx.authIdentity.upsert({ where: { userId_provider: { userId: stored.userId, provider: "password" } },
        create: { userId: stored.userId, provider: "password", providerUserId: stored.userId, email: account?.email }, update: { email: account?.email } });
      await tx.googleLinkIntent.deleteMany({ where: { userId: stored.userId } });
      await tx.token.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      return true;
    });
    if (!consumed) return invalid();
    return { code: 200, status: "success", message: "Password reset successfully" };
  } catch (error) {
    if (error instanceof PasswordProcessingBusy) return { code: 503, status: "error", message: "Password processing is busy. Please try again shortly." };
    console.error("Password reset unavailable; no account or credential details logged");
    return { code: 500, status: "error", message: "Unable to reset password. Please try again later." };
  }
}
