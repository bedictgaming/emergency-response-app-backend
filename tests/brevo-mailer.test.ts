import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ smtp: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.smtp } }));
const mail = { to: 'controlled@example.test', subject: 'Synthetic account test', html: '<p>synthetic-capability-only</p>' };
const receipt = '<synthetic.123@relay.example.test>';
const key = 'xkeysib-synthetic-test-key-only';

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('MAIL_PROVIDER', 'brevo');
  vi.stubEnv('MAIL_FROM', 'sender@example.test'); vi.stubEnv('BREVO_API_KEY', key);
  vi.stubEnv('APP_NAME', 'Cordova Emergency Response');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Brevo single-message HTTPS transport', () => {
  it('uses the fixed API and a single recipient, with no SMTP/relay/contact import', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: receipt }), { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    const { sendEmail } = await import('@/services/mail/mailer');
    await sendEmail(mail);
    expect(fetcher).toHaveBeenCalledOnce(); expect(mocks.smtp).not.toHaveBeenCalled();
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: {
      'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json',
    } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toEqual({ sender: { name: 'Cordova Emergency Response', email: 'sender@example.test' },
      to: [{ email: mail.to }], subject: mail.subject, htmlContent: mail.html });
    expect(console.info).toHaveBeenCalledWith('Account email accepted by transport', { provider: 'brevo' });
    const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
    for (const value of [key, mail.to, mail.html, receipt]) expect(logs).not.toContain(value);
  });
  it.each([[400, 'MAIL_PROVIDER_REJECTED'], [401, 'MAIL_AUTH'], [403, 'MAIL_SENDER'], [429, 'MAIL_RATE_LIMIT'],
    [500, 'MAIL_PROVIDER_REJECTED'], [503, 'MAIL_PROVIDER_REJECTED'], [302, 'MAIL_PROVIDER_REJECTED']])(
    'sanitizes HTTP %s without retries, SMTP or relay fallback', async (status, category) => {
      const fetcher = vi.fn().mockResolvedValue(new Response('private-key-recipient-capability', { status: Number(status) }));
      vi.stubGlobal('fetch', fetcher);
      const { sendEmail } = await import('@/services/mail/mailer');
      const error = await sendEmail(mail).catch(error => error);
      expect(error.message).toBe(category); expect(error.cause).toBeUndefined();
      expect(fetcher).toHaveBeenCalledOnce(); expect(mocks.smtp).not.toHaveBeenCalled();
      expect(console.info).not.toHaveBeenCalled();
    },
  );
  it.each(['not-json', '{}', 'null', '[]', '{"id":"wrong-provider-receipt"}', '{"messageIds":["not-a-single-receipt"]}',
    '{"messageId":null}', '{"messageId":1}', '{"messageId":""}', '{"messageId":"bad\\r\\nheader"}',
    JSON.stringify({ messageId: 'x'.repeat(513) }), JSON.stringify({ messageId: 'x'.repeat(20_000) })])(
    'rejects malformed or oversized receipts', async body => {
      const fetcher = vi.fn().mockResolvedValue(new Response(body, { status: 201 })); vi.stubGlobal('fetch', fetcher);
      const { sendEmail } = await import('@/services/mail/mailer');
      await expect(sendEmail(mail)).rejects.toThrow(/^MAIL_RESPONSE$/);
      expect(fetcher).toHaveBeenCalledOnce(); expect(console.info).not.toHaveBeenCalled();
    },
  );
  it.each([200, 202, 204])('does not call unexpected HTTP %s accepted', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(status === 204 ? null : JSON.stringify({ messageId: receipt }), { status })));
    const { sendEmail } = await import('@/services/mail/mailer');
    await expect(sendEmail(mail)).rejects.toThrow(/^MAIL_RESPONSE$/);
  });
  it('bounds the whole body across multiple chunks, not just each chunk', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(9000)); controller.enqueue(new Uint8Array(9000));
    }, cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 201 })));
    const { sendEmail } = await import('@/services/mail/mailer');
    await expect(sendEmail(mail)).rejects.toThrow(/^MAIL_RESPONSE$/); expect(cancel).toHaveBeenCalledOnce();
  });
  it('sanitizes network and redirect failures without replay', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('private-Brevo-key-and-link'));
    vi.stubGlobal('fetch', fetcher);
    const { sendEmail } = await import('@/services/mail/mailer');
    await expect(sendEmail(mail)).rejects.toThrow(/^MAIL_NETWORK$/);
    expect(fetcher).toHaveBeenCalledOnce(); expect(mocks.smtp).not.toHaveBeenCalled();
  });
  it.each(['connection', 'body'])('keeps the deadline active during stalled %s', async phase => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url, options) => phase === 'connection'
      ? new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private timeout')), { once: true }))
      : Promise.resolve(new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener('abort', () => controller.error(new Error('private body timeout')), { once: true });
      } }), { status: 201 })));
    vi.stubGlobal('fetch', fetcher);
    const { sendEmail, MAIL_DELIVERY_TIMEOUT_MS } = await import('@/services/mail/mailer');
    const failed = expect(sendEmail(mail)).rejects.toThrow(/^MAIL_TIMEOUT$/);
    await vi.advanceTimersByTimeAsync(MAIL_DELIVERY_TIMEOUT_MS); await failed;
    expect(fetcher).toHaveBeenCalledOnce(); expect(console.info).not.toHaveBeenCalled();
  });
  it('fails missing key before network access', async () => {
    vi.stubEnv('BREVO_API_KEY', ''); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { sendEmail } = await import('@/services/mail/mailer');
    await expect(sendEmail(mail)).rejects.toThrow(/^MAIL_CONFIGURATION$/);
    expect(fetcher).not.toHaveBeenCalled(); expect(mocks.smtp).not.toHaveBeenCalled();
  });
});
