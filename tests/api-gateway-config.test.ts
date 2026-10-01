import { afterEach, it, expect, vi } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
function configure(patch: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_GATEWAY_REQUIRED', 'true');
  vi.stubEnv('API_GATEWAY_SECRET', 'dedicated-test-gateway-secret-not-used-for-jwt');
  vi.stubEnv('API_GATEWAY_AUDIENCE', 'emergency-response-staging-v1');
  vi.stubEnv('TRUSTED_PROXY_CIDRS', '');
  vi.stubEnv('BACKGROUND_JOBS_ENABLED', 'false');
  vi.stubEnv('EVIDENCE_NAMESPACE', 'emergency-incidents-staging');
  vi.stubEnv('EVIDENCE_DELETION_ENABLED', 'false');
  vi.stubEnv('ORPHAN_EVIDENCE_SWEEP_ENABLED', 'false');
  for (const [key, value] of Object.entries(patch)) vi.stubEnv(key, value);
}
it('accepts explicit authenticated gateway and disabled staging workers', async () => {
  configure({});
  const { ENV } = await import('@/config/env');
  expect(ENV.API_GATEWAY_REQUIRED).toBe(true);
  expect(ENV.TRUSTED_PROXY_CIDRS).toEqual([]);
  expect(ENV.BACKGROUND_JOBS_ENABLED).toBe(false);
  expect(ENV.EVIDENCE_NAMESPACE).toBe('emergency-incidents-staging');
  expect(ENV.EVIDENCE_DELETION_ENABLED).toBe(false);
});
it.each([
  { API_GATEWAY_SECRET: '' }, { API_GATEWAY_AUDIENCE: '' },
  { TRUSTED_PROXY_CIDRS: '127.0.0.1' }, { API_GATEWAY_REQUIRED: 'TRUE' },
  { BACKGROUND_JOBS_ENABLED: '0' },
  { JWT_SECRET: 'dedicated-test-gateway-secret-not-used-for-jwt' },
  { EVIDENCE_NAMESPACE: 'emergency-incidents' }, { EVIDENCE_NAMESPACE: '../shared' },
  { BACKGROUND_JOBS_ENABLED: 'true' }, { EVIDENCE_DELETION_ENABLED: 'true' },
  { ORPHAN_EVIDENCE_SWEEP_ENABLED: 'true' }, { EVIDENCE_DELETION_ENABLED: 'TRUE' },
])('rejects unsafe/incomplete gateway configuration: %j', async (patch) => {
  configure(patch as Record<string, string>);
  await expect(import('@/config/env')).rejects.toThrow();
});
