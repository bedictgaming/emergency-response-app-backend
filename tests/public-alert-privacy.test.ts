import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { alert: mocks } }));

import { AlertRepository } from "@/repositories/alert.repository";

describe("public alert projection", () => {
  it("bounds the feed and selects no linked incident, location, or staff data", async () => {
    mocks.findMany.mockResolvedValue([]);
    await new AlertRepository().findAll();
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 50,
      orderBy: { sentAt: "desc" },
      select: { alertId: true, alertType: true, message: true, severity: true, sentAt: true },
    }));
    expect(mocks.findMany.mock.calls[0][0].include).toBeUndefined();
  });

  it("does not expand relationships in public alert detail", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await new AlertRepository().findById("alert-id");
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { alertId: "alert-id" },
      select: { alertId: true, alertType: true, message: true, severity: true, sentAt: true },
    });
  });
});
