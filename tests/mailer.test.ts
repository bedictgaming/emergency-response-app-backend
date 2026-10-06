import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ send: vi.fn(), create: vi.fn(), close: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.create } }));
const recipient = 'controlled@example.test';
const mail = { to: recipient, subject: 'Account test', html: '<p>synthetic-link-only</p>' };

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.create.mockReturnValue({ sendMail: mocks.send, close: mocks.close });
  mocks.send.mockResolvedValue({ accepted: [recipient], rejected: [] });
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('MAIL_PROVIDER', 'resend');
  vi.stubEnv('MAIL_FROM', 'accounts@example.test'); vi.stubEnv('RESEND_API_KEY', 're_synthetic_test_key_only');
  vi.stubEnv('APP_NAME', 'Emergency Response App');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('HTTPS account email delivery', () => {
  it('sends exactly once to the fixed HTTPS API, with server-only auth and no SMTP', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'synthetic-receipt' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const { sendEmail } = await import('@/services/mail/mailer');
    await sendEmail(mail);
    expect(fetcher).toHaveBeenCalledOnce(); expect(mocks.create).not.toHaveBeenCalled();
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer re_synthetic_test_key_only' } });
    expect(JSON.parse(options.body)).toEqual({ from: '"Emergency Response App" <accounts@example.test>', to: [recipient], subject: mail.subject, html: mail.html });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(recipient);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('synthetic-receipt');
  });
  it.each([[401, 'MAIL_AUTH'], [403, 'MAIL_SENDER'], [429, 'MAIL_RATE_LIMIT'], [500, 'MAIL_PROVIDER_REJECTED'], [302, 'MAIL_PROVIDER_REJECTED']])(
    'sanitizes HTTP %s and never retries or falls back to SMTP', async (status, category) => {
      const fetcher = vi.fn().mockResolvedValue(new Response('private-recipient-and-key', { status: Number(status) }));
      vi.stubGlobal('fetch', fetcher);
      const { sendEmail } = await import('@/services/mail/mailer');
      await expect(sendEmail(mail)).rejects.toThrow(String(category));
      expect(fetcher).toHaveBeenCalledOnce(); expect(mocks.create).not.toHaveBeenCalled();
      expect(console.info).not.toHaveBeenCalled();
    },
  );
  it.each(['not-json-private-content', '{}', '{"id":null}', JSON.stringify({ id: 'x'.repeat(20_000) })])(
    'fails closed on malformed/oversized success receipts', async body => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
      const { sendEmail } = await import('@/services/mail/mailer');
      await expect(sendEmail(mail)).rejects.toThrow('MAIL_RESPONSE');
      expect(console.info).not.toHaveBeenCalled();
    },
  );
  it('does not leak network error details or automatically replay an ambiguous request', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('private-url-with-key-or-recipient'));
    vi.stubGlobal('fetch', fetcher);
    const { sendEmail } = await import('@/services/mail/mailer');
    await expect(sendEmail(mail)).rejects.toThrow(/^MAIL_NETWORK$/);
    expect(fetcher).toHaveBeenCalledOnce(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('aborts a pending connection at the total delivery deadline', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private-timeout-error')), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const { sendEmail, MAIL_DELIVERY_TIMEOUT_MS } = await import('@/services/mail/mailer');
    const failed = expect(sendEmail(mail)).rejects.toThrow('MAIL_TIMEOUT');
    await vi.advanceTimersByTimeAsync(MAIL_DELIVERY_TIMEOUT_MS);
    await failed; expect(fetcher).toHaveBeenCalledOnce();
  });
  it('keeps the deadline active while reading a stalled response body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => new Response(new ReadableStream({
      start(controller) { options.signal.addEventListener('abort', () => controller.error(new Error('private-body-error')), { once: true }); },
    }), { status: 200 })));
    const { sendEmail, MAIL_DELIVERY_TIMEOUT_MS } = await import('@/services/mail/mailer');
    const failed = expect(sendEmail(mail)).rejects.toThrow('MAIL_TIMEOUT');
    await vi.advanceTimersByTimeAsync(MAIL_DELIVERY_TIMEOUT_MS);
    await failed;
  });
  it('fails missing configuration before any network operation', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); vi.stubEnv('RESEND_API_KEY', '');
    const { sendEmail } = await import('@/services/mail/mailer');
    await expect(sendEmail(mail)).rejects.toThrow('MAIL_CONFIGURATION');
    expect(fetcher).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('retained explicit SMTP transport', () => {
  beforeEach(() => {
    vi.stubEnv('MAIL_PROVIDER', 'smtp'); vi.stubEnv('SMTP_HOST', 'smtp.example.test'); vi.stubEnv('SMTP_PORT', '587');
    vi.stubEnv('SMTP_SECURE', 'false'); vi.stubEnv('SMTP_USER', 'synthetic-user'); vi.stubEnv('SMTP_PASSWORD', 'synthetic-password');
  });
  it('uses bounded SMTP only when selected, with the shared application-name fallback', async () => {
    vi.stubEnv('APP_NAME', undefined); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { sendEmail } = await import('@/services/mail/mailer');
    await sendEmail(mail);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000 }));
    expect(mocks.send).toHaveBeenCalledWith({ ...mail, from: { name: 'Emergency Response App', address: 'accounts@example.test' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not call a rejected recipient accepted', async () => {
    mocks.send.mockResolvedValue({ accepted: [], rejected: [recipient] });
    const { sendEmail } = await import('@/services/mail/mailer');
    await expect(sendEmail(mail)).rejects.toThrow('MAIL_PROVIDER_REJECTED');
  });
  it.each([['EAUTH', 'MAIL_AUTH'], ['ETIMEDOUT', 'MAIL_TIMEOUT'], ['ESOCKET', 'MAIL_NETWORK']])(
    'sanitizes SMTP %s errors', async (code, category) => {
      mocks.send.mockRejectedValue(Object.assign(new Error('private-SMTP-credentials-or-recipient'), { code }));
      const { sendEmail } = await import('@/services/mail/mailer');
      await expect(sendEmail(mail)).rejects.toThrow(category);
    },
  );
});
