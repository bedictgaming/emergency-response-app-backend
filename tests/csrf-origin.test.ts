import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "@/app";
import { ENV } from "@/config/env";

describe("cross-origin mutation protection", () => {
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
