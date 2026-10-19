import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export type LocalCloudinaryCredentials = { cloudName: string; apiKey: string; apiSecret: string };
const CLOUD = /^[a-z0-9][a-z0-9_-]{1,79}$/;
const KEY = /^[0-9]{10,30}$/;
const SECRET = /^[A-Za-z0-9_-]{16,128}$/;
const invalid = () => new Error('LOCAL_CLOUDINARY_CONFIG_INVALID');

/** Shape and local-purpose validation are not proof of provider account ownership. */
export function validateLocalCloudinaryCredentials(value: unknown): LocalCloudinaryCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const config = value as Record<string, unknown>;
  const keys = ['format', 'purpose', 'evidenceNamespace', 'cloudName', 'apiKey', 'apiSecret'];
  if (Object.keys(config).length !== keys.length || Object.keys(config).some(key => !keys.includes(key))
    || config.format !== 'emergency-response-local-cloudinary-v1' || config.purpose !== 'local-demo-only'
    || config.evidenceNamespace !== 'emergency-incidents-development'
    || typeof config.cloudName !== 'string' || !CLOUD.test(config.cloudName)
    || typeof config.apiKey !== 'string' || !KEY.test(config.apiKey)
    || typeof config.apiSecret !== 'string' || !SECRET.test(config.apiSecret)) throw invalid();
  return { cloudName: config.cloudName, apiKey: config.apiKey, apiSecret: config.apiSecret };
}

/** Called only after the existing protected local directory/database/runtime checks. */
export function readLocalCloudinaryCredentials(directory: string): LocalCloudinaryCredentials | undefined {
  const file = path.join(directory, 'cloudinary-private.json');
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192
      || realpathSync(file).toLowerCase() !== file.toLowerCase()) throw invalid();
    return validateLocalCloudinaryCredentials(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw invalid(); // Native IO/JSON/provider messages may include private content.
  }
}

export function localCloudinaryUnavailable(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'development' && env.LOCAL_DEV_ACTIVE === 'true'
    && (!CLOUD.test(env.CLOUDINARY_CLOUD_NAME || '') || !KEY.test(env.CLOUDINARY_API_KEY || '')
      || !SECRET.test(env.CLOUDINARY_API_SECRET || ''));
}

export const LOCAL_CLOUDINARY_UNAVAILABLE_MESSAGE =
  'Photo upload is not configured for this local demo. Configure the separate development photo storage and restart the backend.';
