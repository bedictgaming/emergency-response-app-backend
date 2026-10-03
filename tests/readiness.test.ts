import { afterEach, expect, it, vi } from 'vitest';
import { createReadinessCheck } from '@/lib/readiness';
afterEach(() => vi.useRealTimers());
it('bounds hung probes and keeps one query in flight even after timeout', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const probe = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const check = createReadinessCheck(probe, 3000, 1000);
  const first = check(); const concurrent = check();
  await vi.advanceTimersByTimeAsync(3000);
  expect(await first).toBe(false); expect(await concurrent).toBe(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await check()).toBe(false); expect(probe).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(2000);
  const next = check(); await vi.advanceTimersByTimeAsync(3000);
  expect(await next).toBe(false); expect(probe).toHaveBeenCalledTimes(2);
});
it('briefly caches success and reports failure without leaking provider errors', async () => {
  vi.useFakeTimers(); const probe = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('private-host-secret'));
  const check = createReadinessCheck(probe);
  expect(await check()).toBe(true); expect(await check()).toBe(true);
  expect(probe).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await check()).toBe(false);
});
