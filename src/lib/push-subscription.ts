import { ECDH } from "node:crypto";
import { lookup } from "node:dns";
import { Agent } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { z } from "zod";
import webpush from "web-push";

export const MAX_PUSH_DEVICES_PER_USER = 10;
export const PUSH_DELIVERY_DEADLINE_MS = 10_000;
export const MAX_PUSH_JOB_ATTEMPTS = 8;

export class InvalidPushSubscription extends Error {
  constructor() { super("Invalid or unsafe push subscription"); }
}
export class PushDeliveryError extends Error {
  constructor(public readonly retryUserIds: string[]) { super("Push delivery temporarily unavailable"); }
}

// Explicit provider domains, not arbitrary caller-controlled HTTPS destinations.
export function isPushProvider(hostname: string) {
  return hostname === "fcm.googleapis.com" || hostname === "web.push.apple.com" ||
    hostname === "updates.push.services.mozilla.com" ||
    /^[a-z0-9-]+\.notify\.windows\.com$/.test(hostname);
}

const subscriptionSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  expirationTime: z.number().finite().positive().nullable().optional(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }).strict(),
}).strict();

function decodeKey(value: string, length: number) {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new InvalidPushSubscription();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value.replace(/=+$/, "")) throw new InvalidPushSubscription();
  return bytes;
}

export function parsePushSubscription(token: string): webpush.PushSubscription {
  try {
    if (typeof token !== "string" || token.length < 20 || token.length > 4096) throw new InvalidPushSubscription();
    const parsed = subscriptionSchema.parse(JSON.parse(token));
    if (parsed.expirationTime != null && parsed.expirationTime <= Date.now()) throw new InvalidPushSubscription();
    if (/[\s\\#]/.test(parsed.endpoint)) throw new InvalidPushSubscription();
    const url = new URL(parsed.endpoint);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
        !isPushProvider(url.hostname) || (url.pathname === "/" && !url.search)) throw new InvalidPushSubscription();
    const publicKey = decodeKey(parsed.keys.p256dh, 65);
    if (publicKey[0] !== 4) throw new InvalidPushSubscription();
    ECDH.convertKey(publicKey, "prime256v1", undefined, undefined, "uncompressed");
    decodeKey(parsed.keys.auth, 16);
    // Use WHATWG's normalized URL consistently, including in web-push's legacy
    // URL parser. No unvalidated extra fields/options reach the transport.
    return { endpoint: url.href, keys: parsed.keys };
  } catch { throw new InvalidPushSubscription(); }
}

const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) denied.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  denied.addSubnet(address, prefix, "ipv6");
}

export function isPublicPushAddress(address: string) {
  if (address.includes("%")) return false;
  const family = isIP(address);
  return family === 4 ? !denied.check(address, "ipv4") :
    family === 6 && globalV6.check(address, "ipv6") && !denied.check(address, "ipv6");
}

// This lookup is attached to the *actual* TLS connection. A separate preflight
// lookup would leave a DNS-rebinding race between validation and connection.
export const safePushLookup: LookupFunction = (hostname, options, callback) => {
  if (!isPushProvider(hostname)) { callback(new InvalidPushSubscription(), "", 4); return; }
  let finished = false;
  const timer = setTimeout(() => {
    finished = true;
    callback(new Error("Push DNS lookup timed out"), "", 4);
  }, 3000);
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (error) { callback(new Error("Push DNS lookup unavailable"), "", 4); return; }
    if (!addresses.length) { callback(new Error("Push DNS lookup unavailable"), "", 4); return; }
    if (addresses.some(({ address }) => !isPublicPushAddress(address))) {
      callback(new InvalidPushSubscription(), "", 4); return;
    }
    const candidates = options.family ? addresses.filter(({ family }) => family === options.family) : addresses;
    if (!candidates.length) { callback(new Error("Push DNS family unavailable"), "", 4); return; }
    if (options.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  });
};

export async function deliverPush(subscription: webpush.PushSubscription, payload: string) {
  // Keep the network boundary safe even if a future internal caller forgets to
  // validate first: literal IP connections bypass Node's DNS lookup hook.
  const validated = parsePushSubscription(JSON.stringify(subscription));
  const agent = new Agent({ lookup: safePushLookup, keepAlive: false, maxSockets: 1 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // web-push does not follow redirects. Its socket timeout alone does not
    // bound DNS/TLS/slow responses; enforce a total deadline and abort sockets.
    return await Promise.race([
      webpush.sendNotification(validated, payload, { agent, timeout: 5000 }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { agent.destroy(); reject(new Error("Push delivery timed out")); }, PUSH_DELIVERY_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    agent.destroy();
  }
}
