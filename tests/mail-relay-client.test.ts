import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendViaRelay } from '@/services/mail/relay-client';
import { readMailConfiguration } from '@/services/mail/mail-config';
import { createHash, createHmac } from 'node:crypto';

const secret = 'a7'.repeat(32);
const config = { provider: 'vercel-relay' as const, endpoint: 'https://cordova-emergency-response.vercel.app/api/account-email', audience: 'account-mail-test-v1', secret };
const action = { purpose: 'VERIFY_EMAIL' as const, url: 'https://cordova-emergency-response.vercel.app/api/auth/v1/verify-email?token=12345678-1234-4123-8123-123456789abc',
  expiresAt: new Date(Date.now() + 60_000).toISOString(), name: 'Synthetic recipient' };

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Railway-to-Vercel relay client', () => {
  it('signs the exact same-project endpoint and body using the independent protocol contract', async () => {
    const fetcher = vi.fn(async (url, options) => {
      const headers = new Headers(options.headers); const endpoint = new URL(url);
      const canonical = ['account-email-v1', 'POST', endpoint.origin, endpoint.pathname, config.audience,
        headers.get('X-Mail-Timestamp'), headers.get('X-Mail-Nonce'), createHash('sha256').update(options.body).digest('hex')].join('\n');
      expect(headers.get('X-Mail-Signature')).toBe(createHmac('sha256', Buffer.from(secret, 'hex')).update(canonical).digest('hex'));
      expect(headers.get('X-Mail-Nonce')).toMatch(/^[a-f0-9-]{36}$/);
      expect(headers.get('X-Mail-Audience')).toBe(config.audience);
      return new Response('{"accepted":true}');
    });
    vi.stubGlobal('fetch', fetcher);
    await sendViaRelay(config, 'controlled@example.test', action);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ to: 'controlled@example.test', ...action });
  });
  it('binds production and staging mail destinations to the selected backend environment', () => {
    const input = { NODE_ENV: 'production', MAIL_PROVIDER: config.provider, MAIL_RELAY_URL: config.endpoint, MAIL_RELAY_AUDIENCE: config.audience, MAIL_RELAY_SECRET: secret };
    expect(readMailConfiguration(input)).toEqual(config);
    expect(() => readMailConfiguration({ ...input, RAILWAY_ENVIRONMENT_NAME: 'staging' })).toThrow('MAIL_CONFIGURATION');
    const stageUrl = 'https://synthetic-stage.vercel.app/api/account-email';
    expect(() => readMailConfiguration({ ...input, MAIL_RELAY_URL: stageUrl })).toThrow('MAIL_CONFIGURATION');
    expect(readMailConfiguration({ ...input, MAIL_RELAY_URL: stageUrl, RAILWAY_ENVIRONMENT_NAME: 'staging' }).provider).toBe('vercel-relay');
  });
  it('validates selected configuration without needing SMTP or Resend', () => {
    expect(readMailConfiguration({ MAIL_PROVIDER: config.provider, MAIL_RELAY_URL: config.endpoint, MAIL_RELAY_AUDIENCE: config.audience, MAIL_RELAY_SECRET: secret })).toEqual(config);
    for (const changed of [{ MAIL_RELAY_SECRET: '' }, { MAIL_RELAY_URL: 'http://127.0.0.1/api/send-account-email' },
      { MAIL_RELAY_URL: config.endpoint + '?key=secret' }, { JWT_SECRET: secret }, { API_GATEWAY_SECRET: secret },
      { BREVO_API_KEY: secret }, { MAIL_RELAY_AUDIENCE: '' }]) {
      expect(() => readMailConfiguration({ MAIL_PROVIDER: config.provider, MAIL_RELAY_URL: config.endpoint, MAIL_RELAY_AUDIENCE: config.audience, MAIL_RELAY_SECRET: secret, ...changed })).toThrow('MAIL_CONFIGURATION');
    }
  });
  it('fails missing typed action before networking', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(sendViaRelay(config, 'controlled@example.test')).rejects.toThrow('MAIL_CONFIGURATION');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([[401, 'MAIL_AUTH'], [429, 'MAIL_RATE_LIMIT'], [409, 'MAIL_PROVIDER_REJECTED'], [503, 'MAIL_PROVIDER_REJECTED'], [302, 'MAIL_PROVIDER_REJECTED']])('sanitizes %s without automatic retries', async (status, category) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('private-error-key-or-link', { status })); vi.stubGlobal('fetch', fetcher);
    await expect(sendViaRelay(config, 'controlled@example.test', action)).rejects.toThrow(category);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['{}', 'private-raw-response', '{"accepted":false}', 'x'.repeat(2048)])('rejects bad bounded receipts', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    await expect(sendViaRelay(config, 'controlled@example.test', action)).rejects.toThrow('MAIL_RESPONSE');
  });
  it('sanitizes network failures', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('private-key-and-link')); vi.stubGlobal('fetch', fetcher);
    await expect(sendViaRelay(config, 'controlled@example.test', action)).rejects.toThrow(/^MAIL_NETWORK$/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('bounds the complete request including stalled receipt bodies', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => new Response(new ReadableStream({
      start(controller) { options.signal.addEventListener('abort', () => controller.error(new Error('private-body-error')), { once: true }); },
    }))));
    const result = expect(sendViaRelay(config, 'controlled@example.test', action)).rejects.toThrow('MAIL_TIMEOUT');
    await vi.advanceTimersByTimeAsync(20_000); await result;
  });
});
