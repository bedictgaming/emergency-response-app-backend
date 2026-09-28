import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "@/app";

describe("read request validation", () => {
  it("rejects malformed public alert filters and IDs before Prisma", async () => {
    const invalidId = await request(app).get("/api/alerts/v1/not-a-uuid").expect(400);
    const invalidFilter = await request(app).get("/api/alerts/v1/?severity=UNKNOWN").expect(400);
    expect(invalidId.body.code).toBe(400);
    expect(invalidFilter.body.code).toBe(400);
  });

  it("keeps validation errors in the documented envelope", async () => {
    const response = await request(app).post("/api/auth/v1/login").send({ email: "invalid" }).expect(400);
    expect(response.body).toMatchObject({ code: 400, status: "error", message: "Validation failed" });
  });
});
