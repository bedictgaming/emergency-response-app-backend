import { describe, expect, it, vi } from "vitest";
import { permittedRole } from "@/middlewares/rbac-middleware";
import { Role } from "@/generated/prisma";

function responseMock() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

describe("role-based authorization", () => {
  it("permits dispatchers on operational routes", () => {
    const next = vi.fn();
    const response = responseMock();
    permittedRole([Role.ADMIN, Role.DISPATCHER])(
      { user: { sub: "dispatcher", role: Role.DISPATCHER } } as never,
      response as never,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("denies citizens on operational routes", () => {
    const next = vi.fn();
    const response = responseMock();
    permittedRole([Role.ADMIN, Role.DISPATCHER])(
      { user: { sub: "citizen", role: Role.USER } } as never,
      response as never,
      next,
    );
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
