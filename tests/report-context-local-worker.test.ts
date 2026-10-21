import { describe, expect, it } from 'vitest';
import { localReportContextWorkerEnabled, reportContextWorkerEnabled } from '@/config/report-context-worker';

const valid = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development', LOCAL_DEV_ACTIVE: 'true', LOCAL_DEV_CONFIG_FILE: 'synthetic/backend-private.json',
  DATABASE_URL: `postgresql://er_local_app:${'a'.repeat(64)}@127.0.0.1:55432/emergency_response_dev`,
  REPORT_REQUEST_CONTEXT_ENABLED: 'true', LOCAL_REPORT_CONTEXT_WORKER_ENABLED: 'true', BACKGROUND_JOBS_ENABLED: 'false',
  EVIDENCE_DELETION_ENABLED: 'false', ORPHAN_EVIDENCE_SWEEP_ENABLED: 'false', EVIDENCE_NAMESPACE: 'emergency-incidents-development', API_GATEWAY_REQUIRED: 'false',
});
describe('isolated local retention-only worker policy', () => {
  it('defaults off without parsing or reading any private configuration', () => { expect(localReportContextWorkerEnabled({})).toBe(false); });
  it('permits exactly the verified local target while general/provider/evidence jobs remain disabled', () => {
    const env = valid(); expect(localReportContextWorkerEnabled(env)).toBe(true); expect(env.BACKGROUND_JOBS_ENABLED).toBe('false');
    expect(reportContextWorkerEnabled({ REPORT_REQUEST_CONTEXT_ENABLED: true, BACKGROUND_JOBS_ENABLED: false, LOCAL_REPORT_CONTEXT_WORKER_ENABLED: true })).toBe(true);
    expect(reportContextWorkerEnabled({ REPORT_REQUEST_CONTEXT_ENABLED: false, BACKGROUND_JOBS_ENABLED: false, LOCAL_REPORT_CONTEXT_WORKER_ENABLED: true })).toBe(false);
    expect(reportContextWorkerEnabled({ REPORT_REQUEST_CONTEXT_ENABLED: true, BACKGROUND_JOBS_ENABLED: false })).toBe(false);
  });
  it.each([
    ['NODE_ENV', 'production'], ['NODE_ENV', 'test'], ['LOCAL_DEV_ACTIVE', 'false'], ['LOCAL_DEV_CONFIG_FILE', ''],
    ['BACKGROUND_JOBS_ENABLED', 'true'], ['EVIDENCE_DELETION_ENABLED', 'true'], ['ORPHAN_EVIDENCE_SWEEP_ENABLED', 'true'],
    ['EVIDENCE_NAMESPACE', 'emergency-incidents'], ['API_GATEWAY_REQUIRED', 'true'], ['REPORT_REQUEST_CONTEXT_ENABLED', 'false'],
  ])('rejects an unsafe %s setting', (name, value) => {
    expect(() => localReportContextWorkerEnabled({ ...valid(), [name]: value })).toThrow('REQUIRES_ISOLATED_LOCAL_MODE');
  });
  it.each([
    'postgresql://hosted.example.invalid:55432/emergency_response_dev',
    `postgresql://er_local_app:${'a'.repeat(64)}@127.0.0.1:5432/emergency_response_dev`,
    `postgresql://er_local_app:${'a'.repeat(64)}@127.0.0.1:55432/production`,
    `postgresql://owner:${'a'.repeat(64)}@127.0.0.1:55432/emergency_response_dev`,
    `postgresql://er_local_app:${'a'.repeat(64)}@127.0.0.1:55432/emergency_response_dev?host=hosted.example.invalid`,
    `postgresql://er_local_app:${'a'.repeat(64)}@127.0.0.1:55432/emergency_response_dev#other`,
    'not-a-url',
  ])('rejects every nonmatching/redirected database target (synthetic case %#)', DATABASE_URL => {
    expect(() => localReportContextWorkerEnabled({ ...valid(), DATABASE_URL })).toThrow('REQUIRES_ISOLATED_LOCAL_MODE');
  });
});
