import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Configuration cases supply their complete environment. Do not refill an
// intentionally absent flag from an operator's ignored, now-enabled local .env.
vi.mock('dotenv', () => ({ default: { config: vi.fn(() => ({ parsed: {} })) } }));

beforeEach(() => { vi.resetModules(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('REPORT_REQUEST_CONTEXT_ENABLED', undefined); vi.stubEnv('LOCAL_REPORT_CONTEXT_WORKER_ENABLED', undefined); });
afterEach(() => vi.unstubAllEnvs());
describe('explicit report context retention configuration', () => {
  it('defaults to off without a migration or provider connection', async () => {
    const { ENV } = await import('@/config/env'); expect(ENV.REPORT_REQUEST_CONTEXT_ENABLED).toBe(false);
  });
  it.each(['TRUE', '1', '', 'yes'])('rejects ambiguous flag %j', async value => {
    vi.stubEnv('REPORT_REQUEST_CONTEXT_ENABLED', value);
    await expect(import('@/config/env')).rejects.toThrow('Invalid boolean configuration: REPORT_REQUEST_CONTEXT_ENABLED');
  });
  it('refuses production capture with disabled background expiry', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('REPORT_REQUEST_CONTEXT_ENABLED', 'true'); vi.stubEnv('BACKGROUND_JOBS_ENABLED', 'false');
    await expect(import('@/config/env')).rejects.toThrow('Report request context requires its retention worker');
  });
  it('refuses development capture without either normal expiry or the validated local-only worker', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('REPORT_REQUEST_CONTEXT_ENABLED', 'true'); vi.stubEnv('BACKGROUND_JOBS_ENABLED', 'false');
    await expect(import('@/config/env')).rejects.toThrow('Report request context requires its retention worker');
  });
  it('rejects a local-only exception in production before any provider/database use', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('LOCAL_REPORT_CONTEXT_WORKER_ENABLED', 'true');
    await expect(import('@/config/env')).rejects.toThrow('LOCAL_REPORT_CONTEXT_WORKER_REQUIRES_ISOLATED_LOCAL_MODE');
  });
});
