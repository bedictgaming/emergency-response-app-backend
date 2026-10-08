import crypto from "node:crypto";
import { z } from "zod";
import { ENV } from "@/config/env";

export const linkDigest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const pkceChallenge = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");
export const GOOGLE_LINK_STATE = /^link\.[A-Za-z0-9_-]{43}$/;
export const PKCE_VERIFIER = /^[A-Za-z0-9_-]{43}$/;

function callbackUrl() {
  const url = new URL(ENV.BACKEND_URL);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(ENV.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new Error("Google linking configuration unavailable");
  }
  return `${url.origin}/api/auth/v1/google/callback`;
}

export function googleLinkAuthorization(state: string, challenge: string) {
  if (!ENV.GOOGLE_CLIENT_ID || !ENV.GOOGLE_CLIENT_SECRET || ENV.GOOGLE_CLIENT_ID.startsWith("placeholder") || ENV.GOOGLE_CLIENT_SECRET.startsWith("placeholder")) {
    throw new Error("Google linking configuration unavailable");
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: ENV.GOOGLE_CLIENT_ID, redirect_uri: callbackUrl(), response_type: "code",
    scope: "openid email profile", state, prompt: "select_account consent",
    code_challenge: challenge, code_challenge_method: "S256", access_type: "online",
  }).toString();
  return url.toString();
}

// This input must come ONLY from Google's authenticated userinfo response.
export function verifiedGoogleLinkIdentity(value: unknown): { sub: string; email: string } | null {
  const parsed = z.object({
    sub: z.string().regex(/^[a-zA-Z0-9_-]{1,255}$/), email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    email_verified: z.literal(true), hd: z.string().optional(),
  }).safeParse(value);
  if (!parsed.success) return null;
  const { sub, email, hd } = parsed.data;
  if (!email.endsWith("@gmail.com") && (!hd || hd.trim().toLowerCase() !== email.split("@")[1])) return null;
  return { sub, email };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Google linking provider unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16_384) throw new Error("Google linking provider unavailable");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function exchangeGoogleLinkCode(code: string, verifier: string) {
  // One shared deadline covers both fetches AND streamed bodies. No redirects,
  // retry, ID-token decoding, offline access or persisted provider credentials.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  try {
    const receipt = await boundedJson(await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: abort.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, code_verifier: verifier, grant_type: "authorization_code",
        client_id: ENV.GOOGLE_CLIENT_ID, client_secret: ENV.GOOGLE_CLIENT_SECRET, redirect_uri: callbackUrl() }),
    }));
    const token = z.object({ access_token: z.string().min(1).max(4096), token_type: z.literal("Bearer") }).parse(receipt);
    const identity = verifiedGoogleLinkIdentity(await boundedJson(await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      redirect: "error", signal: abort.signal, headers: { Authorization: `Bearer ${token.access_token}` },
    })));
    if (!identity) throw new Error("Google identity could not be verified");
    return identity;
  } catch {
    // No raw fetch/JSON/Zod cause, tokens, code, identity or secret in errors.
    throw new Error("Google linking could not be completed");
  } finally { clearTimeout(timer); }
}

