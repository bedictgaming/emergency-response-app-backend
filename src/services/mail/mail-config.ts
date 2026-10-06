import { z } from 'zod';
import { MailDeliveryError } from './mail-errors';

const identity = z.object({
  appName: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/),
  from: z.email().max(254),
});
const smtp = identity.extend({
  provider: z.literal('smtp'),
  host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.enum(['true', 'false']).transform(value => value === 'true'),
  user: z.string().min(1),
  password: z.string().min(1),
});
const resend = identity.extend({
  provider: z.literal('resend'),
  apiKey: z.string().min(16).max(512).regex(/^\S+$/),
});
const brevo = identity.extend({
  provider: z.literal('brevo'),
  apiKey: z.string().min(16).max(512).regex(/^[\x21-\x7e]+$/),
});
const relay = z.object({
  provider: z.literal('vercel-relay'),
  endpoint: z.string().regex(/^https:\/\/[a-z0-9-]+\.vercel\.app\/api\/account-email$/),
  audience: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
});
export type MailConfiguration = z.infer<typeof smtp> | z.infer<typeof resend> | z.infer<typeof brevo> | z.infer<typeof relay>;

export function readMailConfiguration(env: NodeJS.ProcessEnv = process.env): MailConfiguration {
  const provider = env.MAIL_PROVIDER ?? 'smtp';
  const common = { appName: env.APP_NAME ?? 'Emergency Response App', from: env.MAIL_FROM || env.SMTP_FROM };
  const result = provider === 'vercel-relay'
    ? relay.safeParse({ provider, endpoint: env.MAIL_RELAY_URL, audience: env.MAIL_RELAY_AUDIENCE, secret: env.MAIL_RELAY_SECRET })
    : provider === 'resend'
    ? resend.safeParse({ ...common, from: env.MAIL_FROM, provider, apiKey: env.RESEND_API_KEY })
    : provider === 'brevo'
    ? brevo.safeParse({ ...common, from: env.MAIL_FROM, provider, apiKey: env.BREVO_API_KEY })
    : smtp.safeParse({ ...common, provider, host: env.SMTP_HOST, port: env.SMTP_PORT ?? '587',
      secure: env.SMTP_SECURE ?? 'false', user: env.SMTP_USER, password: env.SMTP_PASSWORD });
  if (!result.success) throw new MailDeliveryError('MAIL_CONFIGURATION');
  const config = result.data;
  const relaySecret = config.provider === 'vercel-relay' ? config.secret : undefined;
  if (config.provider === 'vercel-relay' && env.NODE_ENV === 'production') {
    const origin = new URL(config.endpoint).origin;
    const staging = env.RAILWAY_ENVIRONMENT_NAME?.toLowerCase() === 'staging'
      || env.API_GATEWAY_AUDIENCE === 'emergency-response-staging-v1';
    if ((staging && origin === 'https://cordova-emergency-response.vercel.app')
      || (!staging && origin !== 'https://cordova-emergency-response.vercel.app')) throw new MailDeliveryError('MAIL_CONFIGURATION');
  }
  if ((relaySecret && [env.JWT_SECRET, env.API_GATEWAY_SECRET, env.SMTP_PASSWORD, env.RESEND_API_KEY, env.BREVO_API_KEY].some(value => value && value === relaySecret))
    || (config.provider === 'resend' && env.NODE_ENV === 'production'
    && config.from.toLowerCase().endsWith('@resend.dev'))) {
    // The sandbox sender cannot deliver to arbitrary citizens; never deploy it as a public sender.
    throw new MailDeliveryError('MAIL_CONFIGURATION');
  }
  return config;
}
