import passport from "passport";
import { Strategy as GoogleStrategy, Profile, VerifyCallback } from "passport-google-oauth20";
import { ENV } from "@/config/env";

passport.use(
  new GoogleStrategy(
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
