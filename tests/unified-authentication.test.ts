import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "@/app";

describe("unified authentication routes", () => {
  it("uses one logout route and clears the unified cookie family", async () => {
    const response = await request(app)
      .post("/api/auth/v1/logout")
      .set("Cookie", ["accessToken=stale-access"])
      .expect(200);

    const cookies = response.headers["set-cookie"] as unknown as string[];
    expect(cookies.some(cookie => cookie.startsWith("accessToken="))).toBe(true);
    expect(cookies.some(cookie => cookie.startsWith("refreshToken="))).toBe(true);
  });

  it("does not expose a parallel administrator authentication API", async () => {
    await request(app).post("/api/auth/v1/admin/login").send({}).expect(404);
    await request(app).post("/api/auth/v1/admin/refresh-token").send({}).expect(404);
    await request(app).post("/api/auth/v1/admin/logout").send({}).expect(404);
    await request(app).get("/api/auth/v1/admin/me").expect(404);
  });
});
