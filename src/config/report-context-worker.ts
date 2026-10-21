/** A narrowly scoped exception for the already-validated Windows demo database.
 * It never enables notification/provider/evidence workers or accepts a hosted URL.
 * configureLocalDevelopment establishes LOCAL_DEV_ACTIVE after its path/runtime
 * checks; the independent target checks here keep a forged marker insufficient.
 */
export function localReportContextWorkerEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.LOCAL_REPORT_CONTEXT_WORKER_ENABLED !== 'true') return false;
  let target: URL;
  try { target = new URL(env.DATABASE_URL || ''); }
  catch { throw new Error('LOCAL_REPORT_CONTEXT_WORKER_REQUIRES_ISOLATED_LOCAL_MODE'); }
  if (env.NODE_ENV !== 'development' || env.LOCAL_DEV_ACTIVE !== 'true' || !env.LOCAL_DEV_CONFIG_FILE
    || env.REPORT_REQUEST_CONTEXT_ENABLED !== 'true' || env.BACKGROUND_JOBS_ENABLED !== 'false'
    || env.EVIDENCE_DELETION_ENABLED !== 'false' || env.ORPHAN_EVIDENCE_SWEEP_ENABLED !== 'false'
    || env.EVIDENCE_NAMESPACE !== 'emergency-incidents-development' || env.API_GATEWAY_REQUIRED !== 'false'
    || target.protocol !== 'postgresql:' || target.hostname !== '127.0.0.1' || target.port !== '55432'
    || target.pathname !== '/emergency_response_dev' || target.username !== 'er_local_app'
    || !/^[a-f0-9]{64}$/.test(target.password) || target.search || target.hash) {
    throw new Error('LOCAL_REPORT_CONTEXT_WORKER_REQUIRES_ISOLATED_LOCAL_MODE');
  }
  return true;
}

export function reportContextWorkerEnabled(env: {
  REPORT_REQUEST_CONTEXT_ENABLED: boolean;
  BACKGROUND_JOBS_ENABLED: boolean;
  LOCAL_REPORT_CONTEXT_WORKER_ENABLED?: boolean;
}): boolean {
  return env.REPORT_REQUEST_CONTEXT_ENABLED
    && (env.BACKGROUND_JOBS_ENABLED || env.LOCAL_REPORT_CONTEXT_WORKER_ENABLED === true);
}
