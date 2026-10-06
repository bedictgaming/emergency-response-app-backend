import crypto from "crypto";
import { UserRepository } from "@/repositories/user.repository";
import { TokenRepository } from "@/repositories/token.repository";
import { hashPassword, PasswordProcessingBusy } from "@/utils/password";
import { renderTemplate } from "@/utils/template";
import { sendEmail } from "@/services/mail/mailer";
import { mailFailureCategory } from '@/services/mail/mail-errors';

const isDev = process.env.NODE_ENV !== "production";

export async function SignupUserService(name: string, email: string, password: string) {
  email = email.trim().toLowerCase();
  const userRepository = new UserRepository();
  const tokenRepository = new TokenRepository();

  try {
    // Check if email is existing
    const existing = await userRepository.findByEmail(email);
    if (existing) {
      return { code: 409, status: "error", message: "Email already registered" };
    }

    // In development, auto-verify the email so no SMTP config is needed
    if (isDev) {
      const created = await userRepository.create({
        name,
        email,
        password: await hashPassword(password),
        emailVerified: new Date(), // auto-verify immediately
      });

      return {
        code: 200,
        status: "success",
        message: "Account created successfully! You can now log in.",
        data: { user: created },
      };
    }

    // --- Production: full email verification flow ---
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24hrs

    const created = await userRepository.create({ name, email, password: await hashPassword(password) });

    try { await tokenRepository.createEmailVerificationToken({ userId: created.id, token, expiresAt }); } catch {
      console.warn("Verification token creation unavailable; account retained for resend");
      return { code: 200, status: "success", message: "Account created, but verification delivery is unavailable. Use Resend verification after one minute.", data: { user: created } };
    }

    const emailVerificationURL = `${process.env.BACKEND_URL}/api/auth/v1/verify-email?token=${encodeURIComponent(token)}`;

    const html = renderTemplate("verify-email.html", {
      name: created.name ?? "there",
      emailVerificationURL,
      expiresAt: expiresAt.toUTCString(),
    });

    try { await sendEmail({
      to: created.email ?? email,
      subject: "Verify your email address",
      html,
      accountAction: { purpose: 'VERIFY_EMAIL', url: emailVerificationURL, name: created.name ?? 'there', expiresAt: expiresAt.toISOString() },
    }); } catch (error) {
      console.warn("Verification email delivery pending; account retained for resend", { category: mailFailureCategory(error) });
      return { code: 200, status: "success", message: "Account created, but verification email delivery failed. Use Resend verification after one minute.", data: { user: created } };
    }

    return {
      code: 200,
      status: "success",
      message: "Account created successfully! Please verify your email.",
      data: { user: created },
    };

  } catch (error) {
    if (error instanceof PasswordProcessingBusy) return { code: 503, status: "error", message: "Sign-in processing is busy. Please try again shortly." };
    console.error("Signup unavailable; no account or credential details logged");
    return { code: 500, status: "error", message: "Unable to create account" };
  }
}
