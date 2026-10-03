import { createECDH } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), send: vi.fn() }));
vi.mock("node:dns", () => ({ lookup: mocks.lookup }));
vi.mock("web-push", () => ({ default: { sendNotification: mocks.send } }));
import { deliverPush, InvalidPushSubscription, isPublicPushAddress, parsePushSubscription, PUSH_DELIVERY_DEADLINE_MS, safePushLookup } from "@/lib/push-subscription";

const curve = createECDH("prime256v1"); curve.generateKeys();
const valid = { endpoint: "https://fcm.googleapis.com/fcm/send/example", expirationTime: null,
  keys: { p256dh: curve.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") },
};
const parse = (value: unknown) => parsePushSubscription(JSON.stringify(value));
const resolve = (host = "fcm.googleapis.com", options = {}) => new Promise<{ address: unknown; family: unknown }>((done, reject) => {
  safePushLookup(host, options, (error, address, family) => error ? reject(error) : done({ address, family }));
});
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
describe("push subscription validation", () => {
  it("accepts real curve keys and browser subscription shape", () => { expect(parse(valid)).toEqual({ endpoint: valid.endpoint, keys: valid.keys }); });
  it.each([
    "https://127.0.0.1/push", "https://[::1]/push", "https://2130706433/push", "http://fcm.googleapis.com/push",
    "https://fcm.googleapis.com.evil.test/push", "https://fcm.googleapis.com@evil.test/push",
    "https://user:pass@fcm.googleapis.com/push", "https://fcm.googleapis.com:444/push",
    "https://fcm.googleapis.com/push#fragment", "https://fcm.googleapis.com./push", "https://example.test/push",
    "https://evil.test\\@fcm.googleapis.com/push", "https://fcm.googleapis.com/push\n", "https://fcm.googleapis.com/",
  ])("rejects unsafe destination %s", endpoint => { expect(() => parse({ ...valid, endpoint })).toThrow(InvalidPushSubscription); });
  it.each(["https://updates.push.services.mozilla.com/wpush/v2/example", "https://web.push.apple.com/example", "https://wns2-something.notify.windows.com/example", "https://cloud.notify.windows.com/?token=example"])("accepts reviewed provider %s", endpoint => { expect(parse({ ...valid, endpoint }).endpoint).toBe(endpoint); });
  it("rejects malformed JSON, extra fields, expired subscriptions and invalid keys", () => {
    expect(() => parsePushSubscription("this is not JSON at all")).toThrow(InvalidPushSubscription);
    for (const value of [null, [], { ...valid, proxy: "https://evil.test" }, { ...valid, expirationTime: 1 },
      { ...valid, keys: { ...valid.keys, auth: "short" } }, { ...valid, keys: { ...valid.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } },
      { ...valid, keys: { ...valid.keys, auth: valid.keys.auth + "!" } }]) expect(() => parse(value)).toThrow(InvalidPushSubscription);
  });
});
describe("connection-bound destination validation", () => {
  it.each(["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.1.1", "192.168.1.1", "192.0.2.1", "198.18.1.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "2002:7f00:1::", "2001:db8::1", "64:ff9b::7f00:1", "not-an-ip"])("blocks private/reserved address %s", address => { expect(isPublicPushAddress(address)).toBe(false); });
  it.each(["8.8.8.8", "142.250.1.1", "2607:f8b0:4000::1", "2001:4860:4860::8888"])("accepts public address %s", address => { expect(isPublicPushAddress(address)).toBe(true); });
  it("rejects the entire DNS result if any answer is private", async () => {
    mocks.lookup.mockImplementation((_host, _options, callback) => callback(null, [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]));
    await expect(resolve()).rejects.toThrow(InvalidPushSubscription);
  });
  it("never resolves an unreviewed host", async () => { await expect(resolve("evil.test")).rejects.toThrow(InvalidPushSubscription); expect(mocks.lookup).not.toHaveBeenCalled(); });
  it("passes checked addresses to the connection without another lookup", async () => {
    mocks.lookup.mockImplementation((_host, _options, callback) => callback(null, [{ address: "8.8.8.8", family: 4 }]));
    expect(await resolve()).toEqual({ address: "8.8.8.8", family: 4 });
    expect(await resolve("fcm.googleapis.com", { all: true })).toEqual({ address: [{ address: "8.8.8.8", family: 4 }], family: undefined });
  });
  it("checks a changed DNS answer on every new connection", async () => {
    mocks.lookup.mockImplementationOnce((_host, _options, cb) => cb(null, [{ address: "8.8.8.8", family: 4 }]))
      .mockImplementationOnce((_host, _options, cb) => cb(null, [{ address: "169.254.169.254", family: 4 }]));
    await resolve(); await expect(resolve()).rejects.toThrow(InvalidPushSubscription);
  });
  it("bounds a stalled DNS lookup and ignores late responses", async () => {
    vi.useFakeTimers(); const callback = vi.fn(); safePushLookup("fcm.googleapis.com", {}, callback);
    await vi.advanceTimersByTimeAsync(3000); expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0].message).toBe("Push DNS lookup timed out");
    mocks.lookup.mock.calls[0][2](null, [{ address: "8.8.8.8", family: 4 }]); expect(callback).toHaveBeenCalledOnce();
  });
});
describe("bounded delivery", () => {
  it("revalidates destinations at the network boundary even for direct internal calls", async () => {
    await expect(deliverPush({ ...valid, endpoint: "https://127.0.0.1/push" }, "{}")).rejects.toThrow(InvalidPushSubscription);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("attaches safe lookup and closes the dedicated agent on success", async () => {
    mocks.send.mockResolvedValue({ statusCode: 201 });
    await deliverPush(parse(valid), "{}");
    const options = mocks.send.mock.calls[0][2]; expect(options.timeout).toBe(5000);
    expect(options.agent.options.lookup).toBe(safePushLookup);
    expect(options.agent.keepAlive).toBe(false);
  });
  it("aborts a stalled transport at its wall-clock deadline", async () => {
    vi.useFakeTimers(); mocks.send.mockReturnValue(new Promise(() => undefined));
    const delivery = deliverPush(parse(valid), "{}");
    const rejection = expect(delivery).rejects.toThrow("Push delivery timed out");
    const destroy = vi.spyOn(mocks.send.mock.calls[0][2].agent, "destroy");
    await vi.advanceTimersByTimeAsync(PUSH_DELIVERY_DEADLINE_MS); await rejection; expect(destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
