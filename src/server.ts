import '@/bootstrap/local-development';
import app, { gatewayGuard } from '@/app';
import { createServer } from 'node:http';
import { attachSocketEvents } from '@/lib/socket-events';
import { ENV } from '@/config/env';
import { processPendingJobs, sweepOrphanedEvidence } from '@/lib/jobs';
import { startReportContextRetentionWorker } from '@/lib/report-context-retention';
import { nearbyResponseStartEnabled } from '@/config/nearby-review';
import { prisma } from '@/lib/prisma';
import { citizenPresence } from '@/lib/citizen-presence';
import { citizenPresenceEnabled } from '@/config/citizen-presence';
import { departmentReportReviewEnabled } from '@/config/report-review';

const startServer = async () => {
  try {
    if (departmentReportReviewEnabled()) {
      let prepared = false;
      try {
        const rows = await prisma.$queryRaw<Array<{ prepared: boolean }>>`SELECT
          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name='incident_review_flags' AND column_name='review_authority'
            AND data_type='character varying' AND is_nullable='NO') AND EXISTS (
            SELECT 1 FROM _prisma_migrations WHERE migration_name='20261023160000_department_report_review'
              AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS prepared`;
        prepared = rows[0]?.prepared === true;
      } catch { /* Never print private database diagnostics. */ }
      if (!prepared) throw new Error('DEPARTMENT_REPORT_REVIEW_SCHEMA_NOT_PREPARED');
    }
    if (nearbyResponseStartEnabled()) {
      let prepared = false;
      try {
        const rows = await prisma.$queryRaw<Array<{ prepared: boolean }>>`SELECT
          to_regclass('public.incident_nearby_response_starts') IS NOT NULL AND EXISTS (
            SELECT 1 FROM _prisma_migrations WHERE migration_name='20261020170000_nearby_response_starts'
              AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS prepared`;
        prepared = rows[0]?.prepared === true;
      } catch { /* Fail before listening; never print a raw database error. */ }
      if (!prepared) throw new Error('NEARBY_RESPONSE_START_SCHEMA_NOT_PREPARED');
    }
    const server = createServer(app);
    attachSocketEvents(server, gatewayGuard);
    if (citizenPresenceEnabled()) {
      const presenceExpiry = setInterval(() => citizenPresence.sweep(), 1000);
      presenceExpiry.unref(); server.once('close', () => clearInterval(presenceExpiry));
    }
    const localHost = ENV.NODE_ENV === 'development' && process.env.LOCAL_DEV_ACTIVE === 'true' ? '127.0.0.1' : undefined;
    server.listen(ENV.PORT, localHost, () => {
      console.log('--------------------------------------------------');
      if (departmentReportReviewEnabled()) console.log('[report-review] Assigned departments decide; Main Admin monitors');
      if (citizenPresenceEnabled()) console.log('[presence] Opt-in online sharing enabled; volatile single-process mode');
      startReportContextRetentionWorker();
      if (ENV.LOCAL_REPORT_CONTEXT_WORKER_ENABLED) console.log('[request-context] Local retention-only worker enabled; general jobs remain disabled');
      if (ENV.BACKGROUND_JOBS_ENABLED) {
        void processPendingJobs().catch(error => console.error('[background-jobs] Unexpected worker failure:', error));
        setInterval(() => void processPendingJobs().catch(error => console.error('[background-jobs] Unexpected worker failure:', error)), 15_000).unref();
        const sweep = () => void sweepOrphanedEvidence().catch(error => console.error('[evidence-cleanup] Orphan scan failed; existing evidence was not changed:', error));
        setTimeout(sweep, 5 * 60_000).unref();
        setInterval(sweep, 24 * 60 * 60_000).unref();
      } else {
        console.log('[background-jobs] Disabled explicitly for isolated staging verification');
      }
      console.log(`🚀 ${ENV.APP_NAME} started successfully!`);
      console.log(`📡 URL: ${ENV.BACKEND_URL}`);
      console.log(`🌍 MODE: ${ENV.NODE_ENV}`);
      console.log('--------------------------------------------------');
    });
  } catch (error) {
    console.error('❌ CRITICAL: Could not start the engine:', error);
    process.exit(1);
  }
};

startServer();
