import { beforeEach, describe, expect, it, vi } from "vitest";
import { createECDH } from "node:crypto";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn(),
  setVapidDetails: vi.fn(), sendNotification: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { deviceToken: {
  findMany: mocks.findMany, findFirst: mocks.findFirst, deleteMany: mocks.deleteMany,
} } }));
vi.mock("@/config/env", () => ({ ENV: {
  WEB_PUSH_PUBLIC_KEY: "public-web-push-key-for-tests",
  WEB_PUSH_PRIVATE_KEY: "private-web-push-key-for-tests",
  WEB_PUSH_SUBJECT: "mailto:test@example.test",
} }));
vi.mock("web-push", () => ({ default: {
  setVapidDetails: mocks.setVapidDetails, sendNotification: mocks.sendNotification,
} }));

import { sendPushNotification } from "@/lib/push";
import { PushDeliveryError } from "@/lib/push-subscription";

const curve = createECDH("prime256v1"); curve.generateKeys();
const subscription = JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/subscription", keys: { p256dh: curve.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } });

describe("push recipient safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
    mocks.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("rechecks ownership and redacts targeted notification details", async () => {
    mocks.findMany.mockResolvedValue([
      { token: `${subscription} `, userId: "recipient" },
      { token: subscription, userId: "recipient" },
    ]);
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ deviceTokenId: "owned" });
    mocks.sendNotification.mockResolvedValue({ statusCode: 201 });

    expect((await sendPushNotification({ title: "Private incident", body: "Sensitive address", userIds: ["recipient"] })).sent).toBe(1);
    expect(mocks.sendNotification).toHaveBeenCalledOnce();
    const payload = JSON.parse(mocks.sendNotification.mock.calls[0][1]);
    expect(payload).toMatchObject({ title: "Emergency response update", body: "Open the app and sign in to view your update." });
    expect(JSON.stringify(payload)).not.toContain("Sensitive address");
  });

  it("does not query subscriptions for an empty audience", async () => {
    expect(await sendPushNotification({ title: "Dispatch", body: "Private", userIds: [] })).toEqual({ sent: 0, skipped: false });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("restricts delivery to web subscriptions owned by the explicit audience", async () => {
    await sendPushNotification({ title: "Task", body: "Private", userIds: ["assigned-user"] });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: { in: ["assigned-user"] }, platform: "web", user: { status: "ACTIVE" } },
    }));
  });

  it("broadcasts only when the caller deliberately omits the audience", async () => {
    await sendPushNotification({ title: "Public alert", body: "Public" });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { platform: "web", user: { status: "ACTIVE" } },
    }));
  });

  it("removes expired browser subscriptions", async () => {
    mocks.findMany.mockResolvedValue([{ token: subscription, userId: "recipient" }]);
    mocks.findFirst.mockResolvedValue({ deviceTokenId: "owned" });
    mocks.sendNotification.mockRejectedValue({ statusCode: 410 });
    await sendPushNotification({ title: "Alert", body: "Public" });
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { OR: [{ token: subscription, userId: "recipient" }] } });
  });
  it("quarantines malformed legacy JSON without blocking a valid later device", async () => {
    mocks.findMany.mockResolvedValue([{ token: "malformed JSON subscription", userId: "bad" }, { token: subscription, userId: "good" }]);
    mocks.findFirst.mockResolvedValue({ deviceTokenId: "owned" }); mocks.sendNotification.mockResolvedValue({ statusCode: 201 });
    expect((await sendPushNotification({ title: "Alert", body: "Public" })).sent).toBe(1);
    expect(mocks.sendNotification).toHaveBeenCalledOnce();
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { OR: [{ token: "malformed JSON subscription", userId: "bad" }] } });
  });
  it("continues after a provider failure and retries only affected users", async () => {
    mocks.findMany.mockResolvedValue([{ token: subscription, userId: "bad" }, { token: subscription + " ", userId: "good" }]);
    mocks.findFirst.mockResolvedValue({ deviceTokenId: "owned" });
    mocks.sendNotification.mockRejectedValueOnce({ statusCode: 503, body: "sensitive endpoint response" }).mockResolvedValueOnce({ statusCode: 201 });
    const error = await sendPushNotification({ title: "Alert", body: "Public" }).catch(error => error);
    expect(error).toBeInstanceOf(PushDeliveryError); expect(error.retryUserIds).toEqual(["bad"]);
    expect(String(error)).not.toContain("sensitive"); expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
  });
  it("does not follow redirects and drops redirecting subscriptions", async () => {
    mocks.findMany.mockResolvedValue([{ token: subscription, userId: "recipient" }]); mocks.findFirst.mockResolvedValue({ deviceTokenId: "owned" });
    mocks.sendNotification.mockRejectedValue({ statusCode: 302, headers: { location: "https://127.0.0.1/" } });
    await sendPushNotification({ title: "Alert", body: "Public" });
    expect(mocks.sendNotification).toHaveBeenCalledOnce(); expect(mocks.deleteMany).toHaveBeenCalled();
  });
});
