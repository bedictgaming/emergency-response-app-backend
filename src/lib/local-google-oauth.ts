import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export type LocalGoogleOAuthCredentials = { clientId: string; clientSecret: string };
const CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET = /^[A-Za-z0-9_-]{16,256}$/;
const CALLBACK = 'http://localhost:8000/api/auth/v1/google/callback';
const invalid = () => new Error('LOCAL_GOOGLE_OAUTH_CONFIG_INVALID');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Accept an unmodified dedicated Web-client download, never a mixed live client. */
export function validateLocalGoogleOAuthCredentials(value: unknown): LocalGoogleOAuthCredentials {
  if (!record(value) || !record(value.web)) throw invalid();
  const web = value.web;
  if (typeof web.client_id !== 'string' || !CLIENT_ID.test(web.client_id)
    || typeof web.client_secret !== 'string' || !CLIENT_SECRET.test(web.client_secret)
    || !Array.isArray(web.redirect_uris) || web.redirect_uris.length !== 1 || web.redirect_uris[0] !== CALLBACK
    || (web.javascript_origins !== undefined && (!Array.isArray(web.javascript_origins)
      || web.javascript_origins.some(origin => origin !== 'http://localhost:3000')))
    || (web.auth_uri !== undefined && !['https://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/v2/auth'].includes(String(web.auth_uri)))
    || (web.token_uri !== undefined && web.token_uri !== 'https://oauth2.googleapis.com/token')) throw invalid();
  return { clientId: web.client_id, clientSecret: web.client_secret };
}

/** Called only after the isolated bootstrap has validated its protected directory. */
export function readLocalGoogleOAuthCredentials(directory: string): LocalGoogleOAuthCredentials | undefined {
  const file = path.join(directory, 'google-oauth-private.json');
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768
      || realpathSync(file).toLowerCase() !== file.toLowerCase()) throw invalid();
    return validateLocalGoogleOAuthCredentials(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // Native IO/JSON failures can include private values or file contents.
    throw invalid();
  }
}

export function localGoogleOAuthUnavailable(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'development' && env.LOCAL_DEV_ACTIVE === 'true'
    && (!CLIENT_ID.test(env.GOOGLE_CLIENT_ID || '') || !CLIENT_SECRET.test(env.GOOGLE_CLIENT_SECRET || ''));
}

export const LOCAL_GOOGLE_OAUTH_UNAVAILABLE_MESSAGE =
  'Google sign-in is not configured for this local demo. Use email/password or configure the separate development Google client.';
