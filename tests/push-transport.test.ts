import https from "node:https";
import { EventEmitter } from "node:events";
import { createECDH } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import webpush from "web-push";
import { deliverPush, parsePushSubscription, safePushLookup } from "@/lib/push-subscription";

afterEach(() => vi.restoreAllMocks());
it("the installed web-push transport uses the guarded agent and rejects redirects without following them", async () => {
  const keys = webpush.generateVAPIDKeys();
  webpush.setVapidDetails("mailto:test@example.test", keys.publicKey, keys.privateKey);
  const curve = createECDH("prime256v1"); curve.generateKeys();
  const subscription = parsePushSubscription(JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/example",
    keys: { p256dh: curve.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } }));
  const request = vi.spyOn(https, "request").mockImplementation(((options, callback) => {
    expect(options.hostname).toBe("fcm.googleapis.com"); expect(options.agent.options.lookup).toBe(safePushLookup);
    expect(options.timeout).toBe(5000); expect(options.agent.options.rejectUnauthorized).not.toBe(false);
    const response = Object.assign(new EventEmitter(), { statusCode: 302, headers: { location: "https://127.0.0.1/" } });
    const outgoing = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn(), end: () => {
      callback(response); queueMicrotask(() => response.emit("end"));
    } });
    return outgoing;
  }) as never);
  await expect(deliverPush(subscription, JSON.stringify({ title: "Synthetic test" }))).rejects.toMatchObject({ statusCode: 302 });
  expect(request).toHaveBeenCalledOnce();
});
