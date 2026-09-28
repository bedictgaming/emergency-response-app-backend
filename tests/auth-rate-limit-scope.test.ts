import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "@/app";

describe("authentication rate-limit scope", () => {
  it("does not consume the login-attempt budget for session verification", async () => {
    for (let attempt = 0; attempt < 35; attempt += 1) {
      const response = await request(app).get("/api/auth/v1/me");
      expect(response.status).toBe(401);
    }
  });

  it("gives Google OAuth its own higher-capacity budget", async () => {
    for (let attempt = 0; attempt < 35; attempt += 1) {
      const response = await request(app).get("/api/auth/v1/google");
      expect(response.status).not.toBe(429);
      expect(response.status).toBe(302);
    }
  });
});
