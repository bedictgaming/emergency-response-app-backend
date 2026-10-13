import type { Profile } from "passport-google-oauth20";
import { z } from "zod";

export function googleSubject(profile: Profile): string | null {
  return profile?.provider === "google" && typeof profile.id === "string" && /^[a-zA-Z0-9_-]{1,255}$/.test(profile.id) ? profile.id : null;
}

// Only accept Passport's authenticated Google userinfo, never a browser body or
// an unverified decoded ID token. Verification alone is not current ownership
// of a third-party (non-Workspace) Google email.
export function googleEmail(profile: Profile) {
  const email = profile?.emails?.[0]?.value?.trim().toLowerCase();
  const claims = profile?._json as { email?: unknown; email_verified?: unknown; hd?: unknown } | undefined;
  const wellFormed = !!email && z.email().safeParse(email).success && typeof claims?.email === "string" && claims.email.trim().toLowerCase() === email;
  const verified = wellFormed && (profile.emails?.[0] as { verified?: unknown } | undefined)?.verified === true && claims?.email_verified === true;
  const hd = typeof claims?.hd === "string" ? claims.hd.trim().toLowerCase() : "";
  return { email: wellFormed ? email! : null, verified,
    authoritative: verified && (email!.endsWith("@gmail.com") || (!!hd && email!.split("@")[1] === hd)) };
}
