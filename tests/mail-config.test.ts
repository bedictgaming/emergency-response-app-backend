import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMailConfiguration } from '@/services/mail/mail-config';

const smtp = { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'test-user', SMTP_PASSWORD: 'synthetic-test-password', SMTP_FROM: 'sender@example.test' };
const resend = { MAIL_PROVIDER: 'resend', MAIL_FROM: 'accounts@example.test', RESEND_API_KEY: 're_synthetic_test_key_only' };
const brevo = { MAIL_PROVIDER: 'brevo', MAIL_FROM: 'sender@gmail.com', BREVO_API_KEY: 'xkeysib-synthetic-test-key-only' };
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('selected account email configuration', () => {
  it('preserves legacy SMTP defaults and the central application-name fallback', () => {
    expect(readMailConfiguration({ ...smtp, MAIL_FROM: '' })).toMatchObject({ provider: 'smtp', appName: 'Emergency Response App', from: smtp.SMTP_FROM, port: 587, secure: false });
  });
  it('supports an explicit SMTP sender and TLS settings', () => {
    expect(readMailConfiguration({ ...smtp, MAIL_FROM: 'accounts@example.test', SMTP_PORT: '465', SMTP_SECURE: 'true' })).toMatchObject({ from: 'accounts@example.test', port: 465, secure: true });
  });
  it('requires no SMTP credentials for HTTPS delivery', () => {
    expect(readMailConfiguration({ ...resend, NODE_ENV: 'production' })).toMatchObject({ provider: 'resend', from: resend.MAIL_FROM });
  });
  it('supports a verified free-email sender in Brevo mode without SMTP or a relay', () => {
    expect(readMailConfiguration({ ...brevo, NODE_ENV: 'production' })).toMatchObject({ provider: 'brevo', from: brevo.MAIL_FROM });
  });
  it.each([
    { ...resend, MAIL_PROVIDER: 'unknown' }, { ...resend, RESEND_API_KEY: '' },
    { ...resend, MAIL_FROM: '' }, { ...resend, MAIL_FROM: 'Sender <accounts@example.test>' },
    { ...resend, APP_NAME: 'Unsafe\r\nBcc:someone@example.test' },
    { ...resend, NODE_ENV: 'production', MAIL_FROM: 'onboarding@resend.dev' },
    { ...smtp, SMTP_PORT: '587junk' }, { ...smtp, SMTP_SECURE: 'yes' }, { ...smtp, SMTP_PASSWORD: '' },
    { ...brevo, BREVO_API_KEY: '' }, { ...brevo, BREVO_API_KEY: 'short' },
    { ...brevo, BREVO_API_KEY: 'xkeysib-synthetic\r\nUnsafe' }, { ...brevo, BREVO_API_KEY: 'x'.repeat(513) },
    { ...brevo, MAIL_FROM: '', SMTP_FROM: 'legacy@example.test' },
    { ...brevo, MAIL_FROM: 'Sender <sender@gmail.com>' }, { ...brevo, APP_NAME: 'Bad\r\nHeader' },
  ])('rejects unsafe/missing configuration without leaking its contents', env => {
    expect(() => readMailConfiguration(env)).toThrow('MAIL_CONFIGURATION');
  });
  it('allows the provider test sender only outside production', () => {
    expect(readMailConfiguration({ ...resend, NODE_ENV: 'test', MAIL_FROM: 'onboarding@resend.dev' }).provider).toBe('resend');
  });
  it.each([resend, brevo])('validates the selected HTTPS provider during production startup without SMTP ($MAIL_PROVIDER)', async selected => {
    for (const [key, value] of Object.entries({
      NODE_ENV: 'production', DATABASE_URL: 'postgresql://test:test@localhost:5432/mail_test',
      JWT_SECRET: 'synthetic-test-secret-at-least-thirty-two-characters', FRONTEND_URL: 'https://example.test', BACKEND_URL: 'https://example.test',
      CLOUDINARY_CLOUD_NAME: 'synthetic', CLOUDINARY_API_KEY: 'synthetic', CLOUDINARY_API_SECRET: 'synthetic',
      WEB_PUSH_PUBLIC_KEY: 'synthetic-public-key-only', WEB_PUSH_PRIVATE_KEY: 'synthetic-private-key-only',
      WEB_PUSH_SUBJECT: 'mailto:test@example.test', API_GATEWAY_REQUIRED: 'false',
      EVIDENCE_NAMESPACE: 'mail-tests', EVIDENCE_DELETION_ENABLED: 'false', ORPHAN_EVIDENCE_SWEEP_ENABLED: 'false',
      ...selected, SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '', SMTP_FROM: '',
    })) vi.stubEnv(key, value);
    const { ENV } = await import('@/config/env');
    expect(ENV.NODE_ENV).toBe('production');
    vi.resetModules(); vi.stubEnv(selected.MAIL_PROVIDER === 'brevo' ? 'BREVO_API_KEY' : 'RESEND_API_KEY', '');
    await expect(import('@/config/env')).rejects.toThrow('MAIL_CONFIGURATION');
  });
});
