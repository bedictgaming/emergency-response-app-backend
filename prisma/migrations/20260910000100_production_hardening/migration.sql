ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'DISPATCHER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'RESPONDER';

CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

ALTER TABLE "User" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "incidents"
  ADD COLUMN "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "verification_notes" TEXT,
  ADD COLUMN "verified_at" TIMESTAMP(3),
  ADD COLUMN "verified_by" TEXT;

UPDATE "incidents"
SET "verification_status" = CASE
  WHEN "status" = 'OPEN' THEN 'PENDING'::"VerificationStatus"
  ELSE 'VERIFIED'::"VerificationStatus"
END;

ALTER TABLE "attachments"
  ADD COLUMN "public_id" TEXT,
  ADD COLUMN "format" TEXT,
  ADD COLUMN "bytes" INTEGER,
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER,
  ADD COLUMN "perceptual_hash" TEXT,
  ADD COLUMN "moderation_status" TEXT,
  ADD COLUMN "verified_at" TIMESTAMP(3);

CREATE TABLE "audit_logs" (
  "audit_log_id" UUID NOT NULL,
  "actor_id" TEXT,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "metadata" JSONB,
  "ip_address" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("audit_log_id")
);

CREATE TABLE "device_tokens" (
  "device_token_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("device_token_id")
);

CREATE UNIQUE INDEX "attachments_public_id_key" ON "attachments"("public_id");
CREATE INDEX "incidents_verification_status_idx" ON "incidents"("verification_status");
CREATE INDEX "incidents_barangay_id_reported_at_idx" ON "incidents"("barangay_id", "reported_at");
CREATE INDEX "incidents_type_id_reported_at_idx" ON "incidents"("type_id", "reported_at");
CREATE INDEX "incidents_status_updated_at_idx" ON "incidents"("status", "updated_at");
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");

ALTER TABLE "incidents" ADD CONSTRAINT "incidents_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
