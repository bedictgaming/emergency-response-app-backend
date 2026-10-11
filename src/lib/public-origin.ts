import type { Response } from 'express';
import { ENV } from '@/config/env';
import { exactOrigin, selectPublicOrigin } from './public-origin-policy';

const production = ENV.NODE_ENV === 'production';
export const trustedOrigins = new Set([ENV.FRONTEND_URL, ENV.BACKEND_URL, ...ENV.ADDITIONAL_FRONTEND_ORIGINS]
  .map(value => exactOrigin(value, production)));
const canonical = exactOrigin(ENV.FRONTEND_URL, production);
const legacy = ENV.API_GATEWAY_REQUIRED && ENV.API_GATEWAY_AUDIENCE === 'emergency-response-production-v1'
  ? 'https://cordova-emergency-response.vercel.app' : undefined;

// Never consult Host, X-Forwarded-Host, Origin, Referer or a returnUrl parameter.
// Only the HMAC-authenticated gateway metadata can choose a live alias.
export function publicAppOrigin(res: Response) {
  return selectPublicOrigin(res.locals?.apiGatewayOrigin, trustedOrigins, canonical, legacy);
}

export function googleCallbackUrl(res: Response) {
  return `${publicApiOrigin(res)}/api/auth/v1/google/callback`;
}

// Direct local/legacy staging deployments may have distinct UI and API origins.
export function publicApiOrigin(res: Response) {
  return selectPublicOrigin(res.locals?.apiGatewayOrigin, trustedOrigins, exactOrigin(ENV.BACKEND_URL, production), legacy);
}
