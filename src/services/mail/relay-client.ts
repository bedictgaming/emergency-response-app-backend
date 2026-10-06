import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { MailConfiguration } from './mail-config';
import { MailDeliveryError } from './mail-errors';

export type AccountEmailAction = {
  purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD';
  url: string;
  expiresAt: string;
  name: string;
};

export async function sendViaRelay(config: Extract<MailConfiguration, { provider: 'vercel-relay' }>, to: string, action?: AccountEmailAction) {
  if (!action) throw new MailDeliveryError('MAIL_CONFIGURATION');
  const endpoint = new URL(config.endpoint);
  const body = JSON.stringify({ to, ...action });
  if (Buffer.byteLength(body) > 4096) throw new MailDeliveryError('MAIL_CONFIGURATION');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const canonical = ['account-email-v1', 'POST', endpoint.origin, endpoint.pathname, config.audience, timestamp, nonce,
    createHash('sha256').update(body).digest('hex')].join('\n');
  const signature = createHmac('sha256', Buffer.from(config.secret, 'hex')).update(canonical).digest('hex');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response: Response | undefined;
  try {
    // One signed request only. A timeout can follow SMTP acceptance; never replay or fall back.
    response = await fetch(config.endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Mail-Audience': config.audience,
        'X-Mail-Timestamp': timestamp, 'X-Mail-Nonce': nonce, 'X-Mail-Signature': signature },
      body,
    });
    if (!response.ok) throw new MailDeliveryError(response.status === 401 ? 'MAIL_AUTH'
      : response.status === 429 ? 'MAIL_RATE_LIMIT' : 'MAIL_PROVIDER_REJECTED');
    const reader = response.body?.getReader();
    if (!reader) throw new MailDeliveryError('MAIL_RESPONSE');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024) throw new MailDeliveryError('MAIL_RESPONSE');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    if (Buffer.concat(chunks).toString('utf8') !== '{"accepted":true}') throw new MailDeliveryError('MAIL_RESPONSE');
  } catch (error) {
    if (controller.signal.aborted) throw new MailDeliveryError('MAIL_TIMEOUT');
    if (error instanceof MailDeliveryError) throw error;
    throw new MailDeliveryError('MAIL_NETWORK');
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel().catch(() => undefined);
  }
}
