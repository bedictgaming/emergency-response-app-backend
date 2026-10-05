ALTER TABLE "incidents" ADD COLUMN "attention_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "incident_service_responses" ADD COLUMN "attention_version" INTEGER NOT NULL DEFAULT 1;
CREATE TABLE "incident_acknowledgements" (
  "user_id" TEXT NOT NULL,
  "incident_id" UUID NOT NULL,
  "scope" TEXT NOT NULL CHECK ("scope" IN ('MAIN','FIRE','MEDICAL','POLICE','HAZARD')),
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("user_id", "incident_id", "scope"),
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE,
  FOREIGN KEY ("incident_id") REFERENCES "incidents"("incident_id") ON DELETE CASCADE
);
ALTER TABLE "notification_outbox"
  ADD COLUMN "audience_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "claim_token" UUID,
  ADD COLUMN "lease_until" TIMESTAMP(3),
  ADD COLUMN "delivered_devices" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "notification_outbox" SET "audience_ids" = "user_ids";
CREATE INDEX "incident_attention_queue_idx" ON "incidents" ("reported_at", "incident_id")
  WHERE "verification_status" = 'VERIFIED' AND "status" IN ('OPEN','ACTIVE','RESPONDING') AND "merged_into_id" IS NULL;
