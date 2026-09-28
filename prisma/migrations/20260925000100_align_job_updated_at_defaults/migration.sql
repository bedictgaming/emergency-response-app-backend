-- Prisma @updatedAt sends timestamps from the application. These migration-
-- introduced database defaults are not part of the current schema model.
ALTER TABLE "asset_cleanup_jobs" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "notification_outbox" ALTER COLUMN "updated_at" DROP DEFAULT;
