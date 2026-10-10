import passport from "passport";
import { Strategy as GoogleStrategy, Profile, VerifyCallback } from "passport-google-oauth20";
import { ENV } from "@/config/env";

// Linking uses a server-generated S256 challenge and a browser-bound HttpOnly
// verifier. Ordinary sign-in retains its existing state-cookie implementation.
class GoogleLinkStrategy extends GoogleStrategy {
  tokenParams(options: { linkVerifier?: string }) {
    return options.linkVerifier ? { code_verifier: options.linkVerifier } : {};
  }
}

passport.use(
  new GoogleLinkStrategy(
    {
      clientID: ENV.GOOGLE_CLIENT_ID!,
      clientSecret: ENV.GOOGLE_CLIENT_SECRET!,
      callbackURL: `${ENV.BACKEND_URL}/api/auth/v1/google/callback`,
    },
    // Simply forward the Google profile to the controller — DB logic lives in the service
    (_accessToken: string, _refreshToken: string, profile: Profile, done: VerifyCallback) => {
      return done(null, profile);
    }
  )
);

export default passport;
