import app from '@/app';
import { ENV } from '@/config/env';
import { processPendingJobs, sweepOrphanedEvidence } from '@/lib/jobs';

const startServer = () => {
  try {
    app.listen(ENV.PORT, () => {
      console.log('--------------------------------------------------');
      void processPendingJobs().catch(error => console.error('[background-jobs] Unexpected worker failure:', error));
      setInterval(() => void processPendingJobs().catch(error => console.error('[background-jobs] Unexpected worker failure:', error)), 15_000).unref();
      const sweep = () => void sweepOrphanedEvidence().catch(error => console.error('[evidence-cleanup] Orphan scan failed; existing evidence was not changed:', error));
      setTimeout(sweep, 5 * 60_000).unref();
      setInterval(sweep, 24 * 60 * 60_000).unref();
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
