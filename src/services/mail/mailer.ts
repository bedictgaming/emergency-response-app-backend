import nodemailer, { Transporter } from "nodemailer";
import { readMailConfiguration, type MailConfiguration } from './mail-config';
import { MailDeliveryError } from './mail-errors';
import { sendViaRelay, type AccountEmailAction } from './relay-client';

type SendEmailParams = {
  to: string;
  subject: string;
  html: string;
  accountAction?: AccountEmailAction;
};

let transporter: Transporter | null = null;
let transporterConfig: string | null = null;
export const MAIL_DELIVERY_TIMEOUT_MS = 10_000;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const MAX_RESPONSE_BYTES = 16_384;

function getTransporter(config: Extract<MailConfiguration, { provider: 'smtp' }>): Transporter {
  const key = JSON.stringify([config.host, config.port, config.secure, config.user, config.password]);
  if (transporter && transporterConfig === key) return transporter;
  transporter?.close();
  transporter = nodemailer.createTransport({
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.password,
    },
  });
  transporterConfig = key;
  return transporter;
}

async function sendViaHttps(config: Extract<MailConfiguration, { provider: 'resend' | 'brevo' }>, mail: SendEmailParams) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAIL_DELIVERY_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    // Fixed HTTPS destination, no redirects or automatic retries/fallback after an ambiguous send.
    const name = config.appName.replace(/[\\"]/g, '\\$&');
    const brevo = config.provider === 'brevo';
    response = await fetch(brevo ? BREVO_ENDPOINT : RESEND_ENDPOINT, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: brevo
        ? { 'api-key': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }
        : { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(brevo
        ? { sender: { name: config.appName, email: config.from }, to: [{ email: mail.to }], subject: mail.subject, htmlContent: mail.html }
        : { from: `"${name}" <${config.from}>`, to: [mail.to], subject: mail.subject, html: mail.html }),
    });
    if (!response.ok) {
      const category = response.status === 401 ? 'MAIL_AUTH'
        : response.status === 403 ? 'MAIL_SENDER'
        : response.status === 429 ? 'MAIL_RATE_LIMIT' : 'MAIL_PROVIDER_REJECTED';
      throw new MailDeliveryError(category);
    }
    // Brevo's immediate single-message endpoint documents HTTP 201 with messageId.
    if (brevo && response.status !== 201) throw new MailDeliveryError('MAIL_RESPONSE');
    // Bound parsing, including slow/oversized bodies. Never expose the provider body or receipt ID.
    const reader = response.body?.getReader();
    if (!reader) throw new MailDeliveryError('MAIL_RESPONSE');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new MailDeliveryError('MAIL_RESPONSE');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new MailDeliveryError('MAIL_RESPONSE'); }
    const receipt = payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)[brevo ? 'messageId' : 'id'] : undefined;
    if (typeof receipt !== 'string'
      || !(brevo ? /^[\x21-\x7e]{1,512}$/ : /^[a-zA-Z0-9_-]{1,128}$/).test(receipt)) {
      throw new MailDeliveryError('MAIL_RESPONSE');
    }
  } catch (error) {
    if (controller.signal.aborted) throw new MailDeliveryError('MAIL_TIMEOUT');
    if (error instanceof MailDeliveryError) throw error;
    throw new MailDeliveryError('MAIL_NETWORK');
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel().catch(() => undefined);
  }
}

export async function sendEmail({ to, subject, html, accountAction }: SendEmailParams) {
  const config = readMailConfiguration();
  // Make controlled staging mail unmistakable; production account subjects stay unchanged.
  if (process.env.API_GATEWAY_AUDIENCE === 'emergency-response-staging-v1'
    || process.env.RAILWAY_ENVIRONMENT_NAME?.toLowerCase() === 'staging') {
    subject = `[STAGING TEST] ${subject}`;
  }
  if (config.provider === 'vercel-relay') {
    await sendViaRelay(config, to, accountAction);
  } else if (config.provider === 'resend' || config.provider === 'brevo') {
    await sendViaHttps(config, { to, subject, html });
  } else {
    try {
      const result = await getTransporter(config).sendMail({
        from: { name: config.appName, address: config.from }, to, subject, html,
      });
      if (!result.accepted?.length || result.rejected?.length) throw new MailDeliveryError('MAIL_PROVIDER_REJECTED');
    } catch (error) {
      if (error instanceof MailDeliveryError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      throw new MailDeliveryError(code === 'EAUTH' ? 'MAIL_AUTH'
        : code === 'ETIMEDOUT' ? 'MAIL_TIMEOUT' : 'MAIL_NETWORK');
    }
  }
  // Transport acceptance is not proof of inbox delivery. No identity, link, key or receipt in logs.
  console.info('Account email accepted by transport', { provider: config.provider });
}
