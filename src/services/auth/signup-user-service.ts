import crypto from "crypto";
import { UserRepository } from "@/repositories/user.repository";
import { TokenRepository } from "@/repositories/token.repository";
import { hashPassword } from "@/utils/password";
import { renderTemplate } from "@/utils/template";
import { sendEmail } from "@/services/mail/mailer";

const isDev = process.env.NODE_ENV !== "production";

export async function SignupUserService(name: string, email: string, password: string) {
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
        password: hashPassword(password),
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

    const created = await userRepository.create({ name, email, password: hashPassword(password) });

    await tokenRepository.createEmailVerificationToken({ userId: created.id, token, expiresAt });

    const emailVerificationURL = `${process.env.BACKEND_URL}/api/auth/v1/verify-email?token=${encodeURIComponent(token)}`;

    const html = renderTemplate("verify-email.html", {
      name: created.name ?? "there",
      emailVerificationURL,
      expiresAt: expiresAt.toUTCString(),
    });

    await sendEmail({
      to: created.email ?? email,
      subject: "Verify your email address",
      html,
    });

    return {
      code: 200,
      status: "success",
      message: "Account created successfully! Please verify your email.",
      data: { user: created },
    };

  } catch (error) {
    console.error("SignupUserService error", error);
    return { code: 500, status: "error", message: "Unable to create account" };
  }
}