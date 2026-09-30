import { describe, expect, it, vi } from "vitest";
import { AuthController } from "@/controllers/auth.controller";
import { GetMeService } from "@/services/auth";
import { signAccessToken, TokenExpiry, verifyAccessToken } from "@/lib/jwt";

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
  GetMeService: vi.fn(async () => ({ code: 200, status: "success", data: { user: { id: "user", role: "USER" } } })),
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
    expect(res.cookie).toHaveBeenCalledWith("accessToken", "private-access", expect.objectContaining({ httpOnly: true, maxAge: 900_000 }));
    const hint = res.cookie.mock.calls.find(([name]) => name === "sessionRenewAt")!;
    expect(hint[1]).toMatch(/^\d{13}$/);
    expect(Number(hint[1])).toBeGreaterThan(Date.now() + 779_000);
    expect(Number(hint[1])).toBeLessThanOrEqual(Date.now() + 780_000);
    expect(hint[2]).toMatchObject({ httpOnly: false, maxAge: 604_800_000 });
    expect(res.json.mock.calls[0][0].data).toEqual({ user: { id: "user", role: "USER" } });
  });

  it("rotates cookies without returning refreshed credentials to JavaScript", async () => {
    const res = response();
    await new AuthController().refresh({ body: {}, cookies: { refreshToken: "private-refresh" } } as never, res as never);
    expect(res.cookie).toHaveBeenCalledWith("refreshToken", "next-refresh", expect.objectContaining({ httpOnly: true }));
    expect(res.cookie).toHaveBeenCalledWith("sessionRenewAt", expect.stringMatching(/^\d{13}$/), expect.objectContaining({ httpOnly: false }));
    expect(res.json.mock.calls[0][0].data).toEqual({ user: { id: "user", role: "USER" } });
  });

  it("bootstraps the hint from verified JWT expiry without exposing the JWT", async () => {
    const token = signAccessToken("user", "USER", TokenExpiry.ACCESS_TOKEN_EXPIRES, "session");
    const user = verifyAccessToken(token)!;
    const res = response();
    await new AuthController().me({ user, cookies: {} } as never, res as never);
    expect(res.cookie).toHaveBeenCalledWith("sessionRenewAt", String(user.exp! * 1000 - 120_000), expect.objectContaining({ httpOnly: false }));
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(token);
  });

  it("does not overwrite an existing hint with an older me response", async () => {
    const res = response();
    await new AuthController().me({ user: { sub: "user", exp: 1_800_000_000 }, cookies: { sessionRenewAt: "1800000900000" } } as never, res as never);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("does not set a scheduling hint when the profile check fails", async () => {
    vi.mocked(GetMeService).mockResolvedValueOnce({ code: 404, status: "error", message: "User not found" });
    const res = response();
    await new AuthController().me({ user: { sub: "missing", exp: 1_800_000_000 }, cookies: {} } as never, res as never);
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
