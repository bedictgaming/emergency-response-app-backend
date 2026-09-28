import dotenv from 'dotenv';
import { z } from 'zod';
import { isIP } from 'node:net';
dotenv.config();

const trustedProxyCidrs = (process.env.TRUSTED_PROXY_CIDRS || '').split(',').map((value) => value.trim()).filter(Boolean);
for (const entry of trustedProxyCidrs) {
  const [address, prefix, extra] = entry.split('/');
  const version = isIP(address);
  const maxPrefix = version === 4 ? 32 : 128;
  if (!version || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > maxPrefix))) {
    throw new Error(`Invalid TRUSTED_PROXY_CIDRS entry: ${entry}`);
  }
}

const raw = {
  APP_NAME: process.env.APP_NAME || 'Emergency Response App',
  PORT: parseInt(process.env.PORT || '8000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'development-only-secret-change-me'),
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:8000',
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || undefined,
  TRUSTED_PROXY_CIDRS: trustedProxyCidrs,
  WEB_PUSH_PUBLIC_KEY: process.env.WEB_PUSH_PUBLIC_KEY || '',
  WEB_PUSH_PRIVATE_KEY: process.env.WEB_PUSH_PRIVATE_KEY || '',
  WEB_PUSH_SUBJECT: process.env.WEB_PUSH_SUBJECT || 'mailto:admin@example.com',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || 'placeholder_client_id',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || 'placeholder_client_secret',
  CLOUDINARY: {
    CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
    API_KEY: process.env.CLOUDINARY_API_KEY || '',
    API_SECRET: process.env.CLOUDINARY_API_SECRET || '',
  },

  SMTP: {
    HOST: process.env.SMTP_HOST,
    PORT: parseInt(process.env.SMTP_PORT || '587', 10),
    USER: process.env.SMTP_USER,
    PASS: process.env.SMTP_PASSWORD,
    FROM: process.env.SMTP_FROM,
  }
};

const productionSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  FRONTEND_URL: z.string().url(),
  BACKEND_URL: z.string().url(),
  CLOUDINARY: z.object({
    CLOUD_NAME: z.string().min(1),
    API_KEY: z.string().min(1),
    API_SECRET: z.string().min(1),
  }),
  SMTP: z.object({
    HOST: z.string().min(1),
    PORT: z.number().int().positive(),
    USER: z.string().min(1),
    PASS: z.string().min(1),
    FROM: z.string().email(),
  }),
  WEB_PUSH_PUBLIC_KEY: z.string().min(20),
  WEB_PUSH_PRIVATE_KEY: z.string().min(20),
  WEB_PUSH_SUBJECT: z.string().min(5),
});

if (raw.NODE_ENV === 'production') {
  const parsed = productionSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid production configuration: ${fields}`);
  }
}

export const ENV = Object.freeze(raw);
