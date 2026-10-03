import express from "express";
import request from "supertest";
import { createECDH } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), lock: vi.fn(), find: vi.fn(), count: vi.fn(), upsert: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction, deviceToken: { deleteMany: mocks.remove } } }));
vi.mock("@/config/env", () => ({ ENV: {} }));
vi.mock("@/middlewares/auth-middleware", () => ({ AuthMiddleware: class {
  execute(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!req.headers["x-test-user"]) return res.status(401).end();
    req.user = { sub: req.headers["x-test-user"] } as never; next();
  }
} }));
import router from "@/routes/notification.routes";
const app = express(); app.use(express.json(), router);
const curve = createECDH("prime256v1"); curve.generateKeys();
const value = { endpoint: "https://fcm.googleapis.com/fcm/send/example", keys: { p256dh: curve.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") } };
const token = JSON.stringify(value); let user = ""; let sequence = 0;
const post = (candidate = token) => request(app).post("/v1/device-token").set("x-test-user", user).send({ token: candidate, platform: "web" });
describe("authenticated push registration", () => {
  beforeEach(() => {
    vi.resetAllMocks(); user = `user-${sequence++}`;
    mocks.transaction.mockImplementation(callback => callback({ $queryRaw: mocks.lock, deviceToken: { findUnique: mocks.find, count: mocks.count, upsert: mocks.upsert } }));
    mocks.find.mockResolvedValue(null); mocks.count.mockResolvedValue(0); mocks.upsert.mockResolvedValue({ deviceTokenId: "device" });
  });
  it("denies anonymous subscription writes", async () => { expect((await request(app).post("/v1/device-token").send({ token, platform: "web" })).status).toBe(401); expect(mocks.transaction).not.toHaveBeenCalled(); });
  it.each(["malformed JSON subscription", JSON.stringify({ ...value, endpoint: "https://127.0.0.1/push" }), JSON.stringify({ ...value, keys: { auth: "bad", p256dh: "bad" } })])("rejects invalid token before persistence", async candidate => {
    expect((await post(candidate)).status).toBe(400); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("serializes quota checks under the user row lock and preserves unsubscribe compatibility", async () => {
    const raw = token + " "; expect((await post(raw)).status).toBe(200);
    expect(mocks.lock.mock.calls[0][0].join("?")).toContain('SELECT id FROM "User" WHERE id = ? FOR UPDATE');
    expect(mocks.lock.mock.calls[0][1]).toBe(user);
    expect(mocks.upsert).toHaveBeenCalledWith({ where: { token: raw }, update: { userId: user, platform: "web" }, create: { userId: user, token: raw, platform: "web" } });
  });
  it("blocks additional or transferred devices at the quota", async () => {
    mocks.count.mockResolvedValue(10); expect((await post()).status).toBe(429); expect(mocks.upsert).not.toHaveBeenCalled();
    mocks.find.mockResolvedValue({ userId: "other" }); expect((await post()).status).toBe(429);
  });
  it("allows refreshing an owned subscription even at the device limit", async () => {
    mocks.find.mockResolvedValue({ userId: user }); mocks.count.mockResolvedValue(10);
    expect((await post()).status).toBe(200); expect(mocks.count).not.toHaveBeenCalled();
  });
  it("allows shared-phone transfer when the new owner has capacity", async () => {
    mocks.find.mockResolvedValue({ userId: "previous-owner" }); expect((await post()).status).toBe(200);
    expect(mocks.upsert.mock.calls[0][0].update.userId).toBe(user);
  });
  it("counts invalid registration attempts in the user-specific budget", async () => {
    for (let i = 0; i < 30; i++) expect((await post("malformed JSON subscription")).status).toBe(400);
    expect((await post()).status).toBe(429); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("can remove an owned malformed legacy token but never another user's token", async () => {
    expect((await request(app).delete("/v1/device-token").set("x-test-user", user).send({ token: "malformed JSON subscription" })).status).toBe(204);
    expect(mocks.remove).toHaveBeenCalledWith({ where: { token: "malformed JSON subscription", userId: user } });
  });
});
