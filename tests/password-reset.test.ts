import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  createToken: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.findUser },
    token: { create: mocks.createToken },
  },
}));
vi.mock("@/config/env", () => ({ ENV: { FRONTEND_URL: "https://response.example.test/" } }));
vi.mock("@/services/mail/mailer", () => ({ sendEmail: mocks.sendEmail }));

import { RequestPasswordResetService } from "@/services/auth/password-reset-service";

describe("password reset delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ id: "user-id", email: "citizen@example.test", status: "ACTIVE" });
    mocks.createToken.mockResolvedValue({ id: "token-id" });
    mocks.sendEmail.mockResolvedValue(undefined);
  });

  it("sends the token to the unified login reset form", async () => {
    const result = await RequestPasswordResetService("citizen@example.test");

    expect(result.code).toBe(202);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    const html = mocks.sendEmail.mock.calls[0][0].html as string;
    const href = html.match(/href="([^"]+)"/)?.[1];
    expect(href).toMatch(/^https:\/\/response\.example\.test\/login\?resetToken=[a-f0-9]{64}$/);

    const token = new URL(href!).searchParams.get("resetToken")!;
    expect(mocks.createToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-id",
        type: "PASSWORD_RESET",
        token: crypto.createHash("sha256").update(token).digest("hex"),
      }),
    });
  });
});
