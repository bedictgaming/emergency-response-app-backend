import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/passport", () => ({ default: {
  initialize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authenticate: (...args: unknown[]) => authenticate(...args),
} }));

import request from "supertest";
import app from "@/app";

describe("Google OAuth state", () => {
  beforeEach(() => {
    authenticate.mockReset();
    authenticate.mockImplementation(() => (_req: unknown, res: { status: (code: number) => { end: () => void } }) => res.status(204).end());
  });

  it("issues a one-time HttpOnly state cookie and passes the same state to Google", async () => {
    const response = await request(app).get("/api/auth/v1/google").expect(204);
    const cookie = (response.headers["set-cookie"] as unknown as string[]).find(value => value.startsWith("google_oauth_state="));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const state = cookie!.split(";", 1)[0].split("=")[1];
    expect(authenticate).toHaveBeenCalledWith("google", expect.objectContaining({ state }));
  });

  it("rejects a callback without the matching cookie before Passport runs", async () => {
    await request(app).get("/api/auth/v1/google/callback?state=attacker").expect(400);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("accepts the callback only when cookie and query state match", async () => {
    const start = await request(app).get("/api/auth/v1/google").expect(204);
    const stateCookie = (start.headers["set-cookie"] as unknown as string[]).find(value => value.startsWith("google_oauth_state="))!.split(";", 1)[0];
    const state = stateCookie.split("=")[1];
    authenticate.mockClear();
    await request(app).get(`/api/auth/v1/google/callback?state=${encodeURIComponent(state)}`).set("Cookie", stateCookie).expect(204);
    expect(authenticate).toHaveBeenCalledWith("google", { session: false });
  });
});
