import { UserRepository } from "@/repositories/user.repository";
import { TokenRepository } from "@/repositories/token.repository";
import { verifyPassword, PasswordProcessingBusy } from "@/utils/password";
import { signAccessToken, signRefreshToken, TokenExpiry } from "@/lib/jwt";
import { hasValidOperationalAssignment, withPermissions } from "@/lib/permissions";

export async function LoginCredentialsService(email: string, password: string) {
  const userRepository = new UserRepository();
  const tokenRepository = new TokenRepository();

  try {
    // Validate User Credentials
    const normalizedEmail = email.trim().toLowerCase();
    const user = await userRepository.findByEmail(normalizedEmail);
    if (!user || !user.password || !(await verifyPassword(password, user.password))) {
      return { code: 401, status: "error", message: "Invalid email or password" };
    }

    if (user.role !== "USER" && !user.emailVerified) {
      return { code: 403, status: "error", message: "Please verify your email first" };
    }
    if (user.status !== "ACTIVE") {
      return { code: 403, status: "error", message: "This account is inactive" };
    }
    if (!hasValidOperationalAssignment(user)) {
      return { code: 403, status: "error", message: "This operational account has no valid department assignment. Contact the main administrator." };
    }

    // Generate Tokens
    const refreshToken = signRefreshToken(user.id, user.role, TokenExpiry.REFRESH_TOKEN_EXPIRES);

    // Save Refresh Token to DB for tracking/rotation
    const session = await tokenRepository.createRefreshToken({
      userId: user.id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });
    const accessToken = signAccessToken(user.id, user.role, TokenExpiry.ACCESS_TOKEN_EXPIRES, session.id);

    return {
      code: 200,
      status: "success",
      message: "Login successful",
      data: {
        tokens: {
          accessToken,
          refreshToken,
          expiresIn: TokenExpiry.ACCESS_TOKEN_EXPIRES,
          refreshExpiresIn: TokenExpiry.REFRESH_TOKEN_EXPIRES,
        },
        user: withPermissions({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          department: user.department,
          isMainAdmin: user.isMainAdmin,
        }),
      },
    };
  } catch (error) {
    if (error instanceof PasswordProcessingBusy) return { code: 503, status: "error", message: "Sign-in processing is busy. Please try again shortly." };
    console.error("Credential login unavailable; no account or credential details logged");
    return { code: 500, status: "error", message: "Unable to login account" };
  }
}
