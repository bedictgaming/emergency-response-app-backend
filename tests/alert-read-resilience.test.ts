import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findAll: vi.fn(), findById: vi.fn() }));
vi.mock("@/repositories/alert.repository", () => ({
  AlertRepository: class {
    findAll = mocks.findAll;
    findById = mocks.findById;
  },
}));

import { GetAllAlertsService } from "@/services/alert/get-all-alerts-service";
import { GetAlertService } from "@/services/alert/get-alert-service";
import { AlertController } from "@/controllers/alert.controller";
import { isTransientDatabaseConnectionError } from "@/lib/transient-database-read";

const connectionReset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("alert read connection recovery", () => {
  it("recognizes Prisma's connection-reset code but not a query defect", () => {
    expect(isTransientDatabaseConnectionError(connectionReset())).toBe(true);
    expect(isTransientDatabaseConnectionError({ code: "P1017", message: "Server closed the connection" })).toBe(true);
    expect(isTransientDatabaseConnectionError({ code: "P2022", message: "Column does not exist" })).toBe(false);
  });

  it("retries a dropped public-feed read once and returns the recovered result", async () => {
    const alerts = [{ alertId: "alert-1" }];
    mocks.findAll.mockRejectedValueOnce(connectionReset()).mockResolvedValueOnce(alerts);

    expect(await GetAllAlertsService()).toEqual({ code: 200, status: "success", data: { alerts } });
    expect(mocks.findAll).toHaveBeenCalledTimes(2);
  });

  it("returns 503 and Retry-After if the feed remains disconnected", async () => {
    mocks.findAll.mockRejectedValue(connectionReset());
    const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };

    await new AlertController().getAll({ query: {} } as never, response as never);

    expect(mocks.findAll).toHaveBeenCalledTimes(2);
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "2");
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 503, status: "error" }));
  });

  it("does not retry permanent query defects", async () => {
    mocks.findAll.mockRejectedValue({ code: "P2022", message: "Column does not exist" });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await GetAllAlertsService()).toEqual({ code: 500, status: "error", message: "Failed to fetch alerts" });
      expect(mocks.findAll).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("returns 503 without replaying a timed-out read", async () => {
    mocks.findAll.mockRejectedValue({ code: "P1008", message: "Operation timed out" });

    expect(await GetAllAlertsService()).toEqual({
      code: 503,
      status: "error",
      message: "Alerts are temporarily unavailable. Please retry shortly.",
    });
    expect(mocks.findAll).toHaveBeenCalledOnce();
  });

  it("also retries the idempotent alert-detail read", async () => {
    const alert = { alertId: "alert-1" };
    mocks.findById.mockRejectedValueOnce(connectionReset()).mockResolvedValueOnce(alert);

    expect(await GetAlertService("alert-1")).toEqual({ code: 200, status: "success", data: { alert } });
    expect(mocks.findById).toHaveBeenCalledTimes(2);
  });

  it("returns 503 for a persistently disconnected alert-detail read", async () => {
    mocks.findById.mockRejectedValue(connectionReset());
    const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };

    await new AlertController().getById({ params: { id: "alert-1" } } as never, response as never);

    expect(mocks.findById).toHaveBeenCalledTimes(2);
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "2");
    expect(response.status).toHaveBeenCalledWith(503);
  });
});
