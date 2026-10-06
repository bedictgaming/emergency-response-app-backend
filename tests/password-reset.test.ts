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
    expect(mocks.sendEmail.mock.calls[0][0].accountAction).toMatchObject({ purpose: 'RESET_PASSWORD', url: href });
    expect(mocks.sendEmail.mock.calls[0][0].accountAction.expiresAt).toBe(mocks.createToken.mock.calls[0][0].data.expiresAt.toISOString());
    expect(mocks.createToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-id",
        type: "PASSWORD_RESET",
        token: crypto.createHash("sha256").update(token).digest("hex"),
      }),
    });
  });
  it('normalizes the email before finding an existing account', async () => {
    await RequestPasswordResetService('  Citizen@Example.test  ');
    expect(mocks.findUser).toHaveBeenCalledWith({ where: { email: 'citizen@example.test' } });
  });
  it('keeps absent, inactive, accepted and failed delivery responses indistinguishable', async () => {
    const accepted = await RequestPasswordResetService('citizen@example.test');
    expect(accepted.message).toContain('requested');
    mocks.findUser.mockResolvedValueOnce(null);
    expect(await RequestPasswordResetService('missing@example.test')).toEqual(accepted);
    mocks.findUser.mockResolvedValueOnce({ email: 'inactive@example.test', status: 'INACTIVE' });
    expect(await RequestPasswordResetService('inactive@example.test')).toEqual(accepted);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.sendEmail.mockRejectedValueOnce(new Error('private-recipient-key-token'));
    expect(await RequestPasswordResetService('citizen@example.test')).toEqual(accepted);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('private-recipient-key-token');
    logged.mockRestore();
  });
});
