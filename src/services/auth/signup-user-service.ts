import { UserRepository } from "@/repositories/user.repository";
import { hashPassword, PasswordProcessingBusy } from "@/utils/password";

export async function SignupUserService(name: string, email: string, password: string) {
  email = email.trim().toLowerCase();
  const userRepository = new UserRepository();
  try {
    const existing = await userRepository.findByEmail(email);
    if (existing) return { code: 409, status: "error", message: "Email already registered" };

    // Public signup only creates citizens (the schema's USER default). Email
    // ownership is unconfirmed, but citizen access does not depend on mail.
    const created = await userRepository.create({
      name, email, password: await hashPassword(password), emailVerified: null,
    });
    return {
      code: 200, status: "success",
      message: "Account created successfully! You can now log in.",
      data: { user: created },
    };
  } catch (error) {
    if (error instanceof PasswordProcessingBusy) return { code: 503, status: "error", message: "Sign-in processing is busy. Please try again shortly." };
    console.error("Signup unavailable; no account or credential details logged");
    return { code: 500, status: "error", message: "Unable to create account" };
  }
}
