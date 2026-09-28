import { describe, expect, it, vi } from "vitest";
import { AuthController } from "@/controllers/auth.controller";

vi.mock("@/services/auth", async (load) => ({
  ...await load<object>(),
  LoginCredentialsService: vi.fn(async () => ({
    code: 200, status: "success", message: "Login successful",
    data: { tokens: { accessToken: "private-access", refreshToken: "private-refresh" }, user: { id: "user", role: "USER" } },
  })),
  RefreshTokenService: vi.fn(async () => ({
    code: 200, status: "success", message: "Session refreshed",
    data: { tokens: { accessToken: "next-access", refreshToken: "next-refresh" }, user: { id: "user", role: "USER" } },
  })),
}));

function response() {
  const res = { cookie: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("browser cookie sessions", () => {
  it("sets HttpOnly cookies without returning login credentials to JavaScript", async () => {
    const res = response();
    await new AuthController().login({ body: { email: "user@example.test", password: "password" } } as never, res as never);
    expect(res.cookie).toHaveBeenCalledWith("refreshToken", "private-refresh", expect.objectContaining({ httpOnly: true }));
    expect(res.json.mock.calls[0][0].data).toEqual({ user: { id: "user", role: "USER" } });
  });

  it("rotates cookies without returning refreshed credentials to JavaScript", async () => {
    const res = response();
    await new AuthController().refresh({ body: {}, cookies: { refreshToken: "private-refresh" } } as never, res as never);
    expect(res.cookie).toHaveBeenCalledWith("refreshToken", "next-refresh", expect.objectContaining({ httpOnly: true }));
    expect(res.json.mock.calls[0][0].data).toEqual({ user: { id: "user", role: "USER" } });
  });
});
