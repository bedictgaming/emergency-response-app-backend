import { beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUser } },
}));

vi.mock("@/lib/jwt", () => ({
  verifyAccessToken: mocks.verifyAccessToken,
}));

import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { permittedRole } from "@/middlewares/rbac-middleware";

function responseMock() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

describe("database-authoritative roles", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const sessionId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("denies an old ADMIN token after the account is changed to USER", async () => {
    mocks.verifyAccessToken.mockReturnValue({ sub: userId, role: Role.ADMIN, type: "access", sessionId });
    mocks.findUser.mockResolvedValue({ id: userId, role: Role.USER, status: "ACTIVE", tokens: [{ id: sessionId }] });

    const request = { headers: { authorization: "Bearer stale-admin-token" } } as never;
    const response = responseMock();
    const controller = vi.fn();

    await new AuthMiddleware().execute(request, response as never, () => {
      permittedRole([Role.ADMIN])(request, response as never, controller);
    });

    expect(mocks.findUser).toHaveBeenCalledWith({
      where: { id: userId },
      select: {
        id: true, role: true, status: true, department: true, isMainAdmin: true,
        tokens: {
          where: { id: sessionId, type: "REFRESH", consumedAt: null, revokedAt: null, expiresAt: { gt: expect.any(Date) } },
          select: { id: true }, take: 1,
        },
      },
    });
    expect(response.status).toHaveBeenCalledWith(403);
    expect(controller).not.toHaveBeenCalled();
  });

  it("rejects a malformed token subject without querying PostgreSQL", async () => {
    mocks.verifyAccessToken.mockReturnValue({ sub: "not-a-uuid", role: Role.USER, type: "access" });

    const request = { headers: { authorization: "Bearer malformed-token" } } as never;
    const response = responseMock();
    const next = vi.fn();

    await new AuthMiddleware().execute(request, response as never, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an access token whose refresh session was revoked or consumed", async () => {
    mocks.verifyAccessToken.mockReturnValue({ sub: userId, role: Role.USER, type: "access", sessionId });
    mocks.findUser.mockResolvedValue({ id: userId, role: Role.USER, status: "ACTIVE", tokens: [] });
    const response = responseMock();
    const next = vi.fn();

    await new AuthMiddleware().execute(
      { headers: { authorization: "Bearer revoked-session-access" } } as never,
      response as never,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects access tokens issued before session-bound tokens were introduced", async () => {
    mocks.verifyAccessToken.mockReturnValue({ sub: userId, role: Role.USER, type: "access" });
    const response = responseMock();
    const next = vi.fn();

    await new AuthMiddleware().execute(
      { headers: { authorization: "Bearer legacy-access" } } as never,
      response as never,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed for an operational account without a department", async () => {
    mocks.verifyAccessToken.mockReturnValue({ sub: userId, role: Role.ADMIN, type: "access", sessionId });
    mocks.findUser.mockResolvedValue({ id: userId, role: Role.ADMIN, status: "ACTIVE", department: null, isMainAdmin: false, tokens: [{ id: sessionId }] });
    const request = { headers: { authorization: "Bearer valid-token" } } as never;
    const response = responseMock();
    const next = vi.fn();
    await new AuthMiddleware().execute(request, response as never, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects malformed MAIN and elevated department assignments before route authorization", async () => {
    mocks.verifyAccessToken.mockReturnValue({ sub: userId, role: Role.ADMIN, type: "access", sessionId });
    const request = { headers: { authorization: "Bearer valid-token" } } as never;
    for (const account of [
      { id: userId, role: Role.DISPATCHER, status: "ACTIVE", department: "MAIN", isMainAdmin: true, tokens: [{ id: sessionId }] },
      { id: userId, role: Role.ADMIN, status: "ACTIVE", department: "FIRE", isMainAdmin: true, tokens: [{ id: sessionId }] },
    ]) {
      mocks.findUser.mockResolvedValue(account);
      const response = responseMock();
      const next = vi.fn();
      await new AuthMiddleware().execute(request, response as never, next);
      expect(response.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("retries one transient database failure", async () => {
    mocks.verifyAccessToken.mockReturnValue({ sub: userId, role: Role.USER, type: "access", sessionId });
    mocks.findUser
      .mockRejectedValueOnce(Object.assign(new Error("database unavailable"), { code: "P1001" }))
      .mockResolvedValueOnce({ id: userId, role: Role.USER, status: "ACTIVE", tokens: [{ id: sessionId }] });

    const request = { headers: { authorization: "Bearer valid-token" } } as never;
    const response = responseMock();
    const next = vi.fn();

    await new AuthMiddleware().execute(request, response as never, next);

    expect(mocks.findUser).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledOnce();
  });

  it("retries a PostgreSQL TLS-handshake reset before rejecting the session", async () => {
    mocks.verifyAccessToken.mockReturnValue({ sub: userId, role: Role.USER, type: "access", sessionId });
    mocks.findUser
      .mockRejectedValueOnce(Object.assign(
        new Error("Client network socket disconnected before secure TLS connection was established"),
        { code: "ECONNRESET" },
      ))
      .mockResolvedValueOnce({ id: userId, role: Role.USER, status: "ACTIVE", tokens: [{ id: sessionId }] });

    const request = { headers: { authorization: "Bearer valid-token" } } as never;
    const response = responseMock();
    const next = vi.fn();

    await new AuthMiddleware().execute(request, response as never, next);

    expect(mocks.findUser).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it("returns 503 instead of throwing when the account lookup remains unavailable", async () => {
    mocks.verifyAccessToken.mockReturnValue({ sub: userId, role: Role.USER, type: "access", sessionId });
    mocks.findUser.mockRejectedValue(
      Object.assign(new Error("database unavailable"), { code: "P1001" }),
    );

    const request = {
      headers: { authorization: "Bearer valid-token" },
      log: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const response = responseMock();
    const next = vi.fn();

    await new AuthMiddleware().execute(request, response as never, next);

    expect(mocks.findUser).toHaveBeenCalledTimes(2);
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "2");
    expect(response.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("logs a persistent connection reset as a warning and returns retryable 503", async () => {
    mocks.verifyAccessToken.mockReturnValue({ sub: userId, role: Role.USER, type: "access", sessionId });
    mocks.findUser.mockRejectedValue(Object.assign(new Error("private TLS detail"), { code: "ECONNRESET" }));

    const warn = vi.fn();
    const error = vi.fn();
    const request = { headers: { authorization: "Bearer valid-token" }, log: { warn, error } } as never;
    const response = responseMock();
    const next = vi.fn();

    await new AuthMiddleware().execute(request, response as never, next);

    expect(mocks.findUser).toHaveBeenCalledTimes(2);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "2");
    expect(warn).toHaveBeenCalledWith(
      { prismaCode: "ECONNRESET" },
      "Authentication account lookup temporarily unavailable",
    );
    expect(error).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
