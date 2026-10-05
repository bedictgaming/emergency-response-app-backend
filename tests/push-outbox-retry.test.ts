import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { notificationOutbox: { findMany: mocks.findMany, updateMany: mocks.updateMany, update: mocks.update } } }));
vi.mock("@/config/env", () => ({ ENV: { BACKGROUND_JOBS_ENABLED: true, EVIDENCE_DELETION_ENABLED: false } }));
vi.mock("@/lib/cloudinary", () => ({ default: {}, deleteImage: vi.fn() }));
vi.mock("@/lib/push", () => ({ sendPushNotification: mocks.send }));
import { processPendingJobs } from "@/lib/jobs";
import { MAX_PUSH_JOB_ATTEMPTS, PushDeliveryError } from "@/lib/push-subscription";
const job = { notificationOutboxId: "job-1", status: "PENDING", attempts: 0, eventType: 'INCIDENT_CREATED', createdAt: new Date(), updatedAt: new Date(), deliveredDevices: [], userIds: ["delivered", "retry"], audienceIds: ["delivered", "retry"], payload: { title: "Update", body: "Private" } };
beforeEach(() => {
  vi.resetAllMocks(); mocks.findMany.mockResolvedValue([job]); mocks.updateMany.mockResolvedValue({ count: 1 }); mocks.update.mockResolvedValue({});
  mocks.send.mockResolvedValue({ sent: 1, skipped: false });
});
it("retains failed work and retries only users with temporary failures", async () => {
  mocks.send.mockRejectedValue(new PushDeliveryError(["retry"])); await processPendingJobs();
  expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'PROCESSING', claimToken: expect.any(String) }), data: expect.objectContaining({ status: "FAILED", attempts: 1, userIds: ["retry"], lastError: "Push delivery failed; retry scheduled" }) }));
});
it("continues to a later job after a failed delivery", async () => {
  mocks.findMany.mockResolvedValue([job, { ...job, notificationOutboxId: "job-2" }]);
  mocks.send.mockRejectedValueOnce(new Error("endpoint token secret")).mockResolvedValueOnce({ sent: 1 });
  await processPendingJobs(); expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ notificationOutboxId: "job-2", claimToken: expect.any(String) }), data: expect.objectContaining({ status: "COMPLETED" }) }));
  expect(JSON.stringify(mocks.updateMany.mock.calls)).not.toContain("endpoint token secret");
});
it("keeps exhausted jobs FAILED for operator review without automatic requeue", async () => {
  mocks.findMany.mockResolvedValue([{ ...job, attempts: MAX_PUSH_JOB_ATTEMPTS - 1 }]);
  mocks.send.mockRejectedValue(new PushDeliveryError(["retry"])); await processPendingJobs();
  expect(mocks.findMany.mock.calls[0][0].where.attempts).toEqual({ lt: MAX_PUSH_JOB_ATTEMPTS });
  expect(mocks.updateMany.mock.calls[1][0].where.attempts).toEqual({ lt: MAX_PUSH_JOB_ATTEMPTS });
  expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", attempts: MAX_PUSH_JOB_ATTEMPTS, lastError: "Push retry limit reached; operator review required" }) }));
});
it("never delivers an unclaimed job", async () => {
  mocks.updateMany.mockResolvedValue({ count: 0 }); await processPendingJobs(); expect(mocks.send).not.toHaveBeenCalled();
});
it('expires old push hints without dropping the underlying incident', async () => {
  mocks.findMany.mockResolvedValue([{ ...job, createdAt: new Date(Date.now() - 16 * 60_000) }]);
  await processPendingJobs(); expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }));
});
it('renews and persists device progress only under its unexpired claim', async () => {
  mocks.send.mockImplementation(async message => { await message.beforeDevice(); await message.onDelivered('opaque-device'); return { sent: 1 }; });
  await processPendingJobs();
  expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ claimToken: expect.any(String), leaseUntil: { gt: expect.any(Date) } }), data: expect.objectContaining({ deliveredDevices: { push: 'opaque-device' } }) }));
});
it('does not advance device delivery after lease ownership is lost', async () => {
  mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
  const deliver = vi.fn();
  mocks.send.mockImplementation(async message => { await message.beforeDevice(); deliver(); });
  await processPendingJobs(); expect(deliver).not.toHaveBeenCalled();
});
