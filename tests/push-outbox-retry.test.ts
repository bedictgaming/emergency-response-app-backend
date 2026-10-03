import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { notificationOutbox: { findMany: mocks.findMany, updateMany: mocks.updateMany, update: mocks.update } } }));
vi.mock("@/config/env", () => ({ ENV: { BACKGROUND_JOBS_ENABLED: true, EVIDENCE_DELETION_ENABLED: false } }));
vi.mock("@/lib/cloudinary", () => ({ default: {}, deleteImage: vi.fn() }));
vi.mock("@/lib/push", () => ({ sendPushNotification: mocks.send }));
import { processPendingJobs } from "@/lib/jobs";
import { MAX_PUSH_JOB_ATTEMPTS, PushDeliveryError } from "@/lib/push-subscription";
const job = { notificationOutboxId: "job-1", status: "PENDING", attempts: 0, userIds: ["delivered", "retry"], payload: { title: "Update", body: "Private" } };
beforeEach(() => {
  vi.resetAllMocks(); mocks.findMany.mockResolvedValue([job]); mocks.updateMany.mockResolvedValue({ count: 1 }); mocks.update.mockResolvedValue({});
  mocks.send.mockResolvedValue({ sent: 1, skipped: false });
});
it("retains failed work and retries only users with temporary failures", async () => {
  mocks.send.mockRejectedValue(new PushDeliveryError(["retry"])); await processPendingJobs();
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", attempts: 1, userIds: ["retry"], lastError: "Push delivery failed; retry scheduled" }) }));
});
it("continues to a later job after a failed delivery", async () => {
  mocks.findMany.mockResolvedValue([job, { ...job, notificationOutboxId: "job-2" }]);
  mocks.send.mockRejectedValueOnce(new Error("endpoint token secret")).mockResolvedValueOnce({ sent: 1 });
  await processPendingJobs(); expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(mocks.update.mock.calls[1][0]).toMatchObject({ where: { notificationOutboxId: "job-2" }, data: { status: "COMPLETED" } });
  expect(JSON.stringify(mocks.update.mock.calls)).not.toContain("endpoint token secret");
});
it("keeps exhausted jobs FAILED for operator review without automatic requeue", async () => {
  mocks.findMany.mockResolvedValue([{ ...job, attempts: MAX_PUSH_JOB_ATTEMPTS - 1 }]);
  mocks.send.mockRejectedValue(new PushDeliveryError(["retry"])); await processPendingJobs();
  expect(mocks.findMany.mock.calls[0][0].where.attempts).toEqual({ lt: MAX_PUSH_JOB_ATTEMPTS });
  expect(mocks.updateMany.mock.calls[1][0].where.attempts).toEqual({ lt: MAX_PUSH_JOB_ATTEMPTS });
  expect(mocks.update.mock.calls[0][0].data).toMatchObject({ status: "FAILED", attempts: MAX_PUSH_JOB_ATTEMPTS, lastError: "Push retry limit reached; operator review required" });
});
it("never delivers an unclaimed job", async () => {
  mocks.updateMany.mockResolvedValue({ count: 0 }); await processPendingJobs(); expect(mocks.send).not.toHaveBeenCalled();
});
