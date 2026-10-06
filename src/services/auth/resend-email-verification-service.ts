import { UserRepository } from "@/repositories/user.repository";
import { TokenRepository } from "@/repositories/token.repository";
import { renderTemplate } from "@/utils/template";
import { sendEmail } from "@/services/mail/mailer";
import { mailFailureCategory } from '@/services/mail/mail-errors';
import { verificationEmailUrl } from './verification-email-url';

export async function ResendEmailVerificationService(email: string) {
  const accepted = { code: 202, status: "success", message: "If an eligible account exists, verification delivery has been requested. Wait one minute before retrying; check your inbox and spam folder." };
  try {
    const user = await new UserRepository().findByEmail(email.trim().toLowerCase());
    if (!user) return accepted;
    const claim = await new TokenRepository().claimVerificationResend(user.id);
    if (!claim) return accepted;
    const emailVerificationURL = verificationEmailUrl(claim.token.token);
    await sendEmail({
      to: claim.user.email ?? email,
      subject: "Verify your email address",
      accountAction: { purpose: 'VERIFY_EMAIL', url: emailVerificationURL, name: claim.user.name ?? 'there', expiresAt: claim.token.expiresAt.toISOString() },
      html: renderTemplate("verify-email.html", { name: claim.user.name ?? "there", emailVerificationURL, expiresAt: claim.token.expiresAt.toUTCString() }),
    });
  } catch (error) {
    console.warn("Verification resend unavailable; citizen may retry after cooldown", { category: mailFailureCategory(error) });
  }
  return accepted;
}
