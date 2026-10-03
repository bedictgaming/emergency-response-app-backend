import { UserRepository } from "@/repositories/user.repository";
import { TokenRepository } from "@/repositories/token.repository";
import { renderTemplate } from "@/utils/template";
import { sendEmail } from "@/services/mail/mailer";

export async function ResendEmailVerificationService(email: string) {
  const accepted = { code: 202, status: "success", message: "If an eligible account exists, verification delivery has been requested. Wait one minute before retrying; check your inbox and spam folder." };
  try {
    const user = await new UserRepository().findByEmail(email.trim().toLowerCase());
    if (!user) return accepted;
    const claim = await new TokenRepository().claimVerificationResend(user.id);
    if (!claim) return accepted;
    const emailVerificationURL = `${process.env.BACKEND_URL}/api/auth/v1/verify-email?token=${encodeURIComponent(claim.token.token)}`;
    await sendEmail({
      to: claim.user.email ?? email,
      subject: "Verify your email address",
      html: renderTemplate("verify-email.html", { name: claim.user.name ?? "there", emailVerificationURL, expiresAt: claim.token.expiresAt.toUTCString() }),
    });
  } catch {
    console.warn("Verification resend unavailable; citizen may retry after cooldown");
  }
  return accepted;
}
