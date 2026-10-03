// Explicit operator opt-in only. No jobs processed, no mail/push/cloud writes.
if (process.argv[2] !== '--read-only') throw new Error('Supply --read-only to inspect the configured database');
const { prisma } = await import('../src/lib/prisma');
const { ENV } = await import('../src/config/env');
try {
  const [pending, failed, exhausted, oldest] = await Promise.all([
    prisma.notificationOutbox.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
    prisma.notificationOutbox.count({ where: { status: 'FAILED' } }),
    prisma.notificationOutbox.count({ where: { status: 'FAILED', attempts: { gte: 8 } } }),
    prisma.notificationOutbox.findFirst({ where: { status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  console.log(JSON.stringify({ workerEnabled: ENV.BACKGROUND_JOBS_ENABLED, pushConfigured: Boolean(ENV.WEB_PUSH_PUBLIC_KEY && ENV.WEB_PUSH_PRIVATE_KEY), pending, failed, exhausted, oldestUnfinishedAgeSeconds: oldest ? Math.max(0, Math.round((Date.now() - oldest.createdAt.getTime()) / 1000)) : null }));
  if (exhausted || (oldest && Date.now() - oldest.createdAt.getTime() > 15 * 60_000)) process.exitCode = 1;
} catch {
  console.error('Operations inspection unavailable; check database health. No private record or connection details logged.');
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
