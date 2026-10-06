import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ENV } from "@/config/env";
import { TokenType } from "@/generated/prisma";
import { hashPassword } from "@/utils/password";
import { sendEmail } from "@/services/mail/mailer";
import { mailFailureCategory } from '@/services/mail/mail-errors';

const digest = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function RequestPasswordResetService(email: string) {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (user?.email && user.status === "ACTIVE") {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await prisma.token.create({
      data: { userId: user.id, type: TokenType.PASSWORD_RESET, token: digest(token), expiresAt },
    });
    const frontendOrigin = ENV.FRONTEND_URL.replace(/\/+$/, "");
    const resetUrl = `${frontendOrigin}/login?resetToken=${encodeURIComponent(token)}`;
    try {
      await sendEmail({
        to: user.email,
        subject: "Reset your Emergency Response password",
        accountAction: { purpose: 'RESET_PASSWORD', url: resetUrl, name: user.name ?? 'there', expiresAt: expiresAt.toISOString() },
        html: `<p>A password reset was requested for your account.</p><p><a href="${resetUrl}">Reset password</a></p><p>This link expires in 30 minutes.</p>`,
      });
    } catch (error) {
      // Keep the response indistinguishable for account-enumeration protection.
      console.error("Unable to deliver password reset email", { category: mailFailureCategory(error) });
    }
  }
  return { code: 202, status: "success", message: "If an eligible account exists, password-reset delivery has been requested. Check your inbox and spam folder." };
}

export async function ResetPasswordService(token: string, password: string) {
  const stored = await prisma.token.findFirst({
    where: { token: digest(token), type: TokenType.PASSWORD_RESET, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!stored) return { code: 400, status: "error", message: "Invalid or expired password-reset token" };
  const hashed = await hashPassword(password);
  const consumed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${stored.userId} FOR UPDATE`;
    const claim = await tx.token.updateMany({
      where: { id: stored.id, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claim.count !== 1) return false;
    await tx.user.update({ where: { id: stored.userId }, data: { password: hashed } });
    await tx.token.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return true;
  });
  if (!consumed) return { code: 400, status: "error", message: "Invalid or expired password-reset token" };
  return { code: 200, status: "success", message: "Password reset successfully" };
}
