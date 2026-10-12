import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "@/app";
import { ENV } from "@/config/env";

describe("cross-origin mutation protection", () => {
  const prefixes = ["/api", "/API", "/Api", "/aPi", "/apI", "/APi", "/aPI", "/ApI"];

  it.each(prefixes)("rejects unsafe requests for %s even without required gateway mode", async (prefix) => {
    for (const context of [
      { Origin: "https://untrusted.example" },
      { Referer: "https://untrusted.example/form" },
      { Referer: "not-a-url" },
      { "Sec-Fetch-Site": "cross-site" },
    ]) {
      const response = await request(app).post(prefix + "/auth/v1/logout")
        .set(context).type("form").send({});
      expect(response.status).toBe(403);
      expect(response.body.message).toBe("Request origin is not allowed");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const root = await request(app).post(prefix).set("Origin", "https://untrusted.example").send({});
    expect(root.status).toBe(403);
    expect(root.body.message).toBe("Request origin is not allowed");
    expect(root.headers["set-cookie"]).toBeUndefined();
  });

  it.each(prefixes)("keeps legitimate configured-origin logout working for %s", async (prefix) => {
    const response = await request(app).post(prefix + "/auth/v1/logout")
      .set("Origin", new URL(ENV.FRONTEND_URL).origin).send({});
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects a cross-site form logout before it can touch session cookies", async () => {
    const response = await request(app)
      .post("/api/auth/v1/logout")
      .set("Origin", "https://untrusted.example")
      .set("Cookie", "refreshToken=untrusted")
      .type("form")
      .send({});
    expect(response.status).toBe(403);
  });

  it("does not reject the configured frontend origin", async () => {
    const response = await request(app)
      .post("/api/auth/v1/logout")
      .set("Origin", new URL(ENV.FRONTEND_URL).origin)
      .send({});
    expect(response.status).toBe(200);
  });
});
