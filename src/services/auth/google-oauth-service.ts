import { Profile } from "passport-google-oauth20";
import { UserRepository } from "@/repositories/user.repository";
import { OAuthAccountRepository } from "@/repositories/oauth-account.repository";
import { TokenRepository } from "@/repositories/token.repository";
import { signAccessToken, signRefreshToken, TokenExpiry } from "@/lib/jwt";
import { hasValidOperationalAssignment, withPermissions } from "@/lib/permissions";

export async function GoogleOAuthService(profile: Profile) {
  const userRepository = new UserRepository();
  const oauthAccountRepository = new OAuthAccountRepository();
  const tokenRepository = new TokenRepository();

  try {
    const googleId = profile.id;
    const email = profile.emails?.[0]?.value ?? null;
    const name = profile.displayName ?? null;

    // 1. Check if we already have an OAuthAccount for this Google ID
    const existingOAuth = await oauthAccountRepository.findByProvider("google", googleId);

    let userId: string;

    if (existingOAuth) {
      // Returning Google user — use the linked userId directly
      userId = existingOAuth.userId;
    } else {
      // New Google login — check if email already exists as a credential account
      let userDbId: string | undefined;

      if (email) {
        const existingUser = await userRepository.findByEmail(email);
        if (existingUser) {
          userDbId = existingUser.id;
          // Existing credential user logging in via Google for the first time → mark verified
          if (!existingUser.emailVerified) {
            await userRepository.markEmailVerified(existingUser.id);
          }
        }
      }

      if (!userDbId) {
        // Brand-new user: create account and auto-verify email (Google confirms it)
        const newUser = await userRepository.create({
          name,
          email,
          emailVerified: new Date(),
        });
        userDbId = newUser.id;
      }

      // Link the Google account to this user
      await oauthAccountRepository.create({
        provider: "google",
        providerAccountId: googleId,
        userId: userDbId,
      });

      userId = userDbId;
    }

    // 2. Load user for role (needed to sign JWT)
    const user = await userRepository.findById(userId);
    if (!user) {
      return { code: 500, status: "error", message: "User not found after Google OAuth" };
    }
    if (!hasValidOperationalAssignment(user)) {
      return { code: 403, status: "error", message: "This operational account has no valid department assignment" };
    }

    // 3. Issue JWT pair
    const refreshToken = signRefreshToken(userId, user.role, TokenExpiry.REFRESH_TOKEN_EXPIRES);

    // 4. Persist refresh token for rotation tracking
    const session = await tokenRepository.createRefreshToken({
      userId,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });
    const accessToken = signAccessToken(userId, user.role, TokenExpiry.ACCESS_TOKEN_EXPIRES, session.id);

    return {
      code: 200,
      status: "success",
      message: "Google OAuth successful",
      data: {
        tokens: { accessToken, refreshToken },
        user: withPermissions({ id: user.id, name: user.name, email: user.email, role: user.role, department: user.department, isMainAdmin: user.isMainAdmin }),
      },
    };
  } catch (error) {
    console.error("GoogleOAuthService error", error);
    return { code: 500, status: "error", message: "Unable to process Google OAuth" };
  }
}
