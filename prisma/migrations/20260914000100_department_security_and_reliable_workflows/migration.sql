CREATE TYPE "Department" AS ENUM ('MAIN', 'FIRE', 'MEDICAL', 'POLICE', 'DRRMO');
CREATE TYPE "ServiceResponseStatus" AS ENUM ('RESPONDING', 'RESOLVED');
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
ALTER TYPE "IncidentStatus" ADD VALUE IF NOT EXISTS 'RESPONDING' AFTER 'ACTIVE';

ALTER TABLE "User"
ADD COLUMN "department" "Department",
ADD COLUMN "is_main_admin" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "incidents"
ADD COLUMN "merged_into_id" UUID,
ADD COLUMN "merged_at" TIMESTAMP(3),
ADD COLUMN "merged_by" TEXT,
ADD COLUMN "merge_reason" TEXT;

-- One-time migration for existing operational accounts. Runtime authorization
-- never derives a department from a name or email.
UPDATE "User" SET "department" = CASE
  WHEN lower(coalesce("email", '') || ' ' || coalesce("name", '')) ~ '(fire|bfp)' THEN 'FIRE'::"Department"
  WHEN lower(coalesce("email", '') || ' ' || coalesce("name", '')) ~ '(medical|ems|health)' THEN 'MEDICAL'::"Department"
  WHEN lower(coalesce("email", '') || ' ' || coalesce("name", '')) ~ '(police|pnp|security)' THEN 'POLICE'::"Department"
  WHEN lower(coalesce("email", '') || ' ' || coalesce("name", '')) ~ '(drrmo|disaster|hazard)' THEN 'DRRMO'::"Department"
  ELSE 'MAIN'::"Department"
END
WHERE "role" IN ('ADMIN', 'DISPATCHER');

UPDATE "User"
SET "is_main_admin" = true
WHERE "role" = 'ADMIN' AND "department" = 'MAIN';

CREATE TABLE "incident_service_responses" (
  "incident_service_response_id" UUID NOT NULL,
  "incident_id" UUID NOT NULL,
  "service" "ResponseService" NOT NULL,
  "status" "ServiceResponseStatus" NOT NULL DEFAULT 'RESPONDING',
  "resolved_at" TIMESTAMP(3),
  "resolved_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "incident_service_responses_pkey" PRIMARY KEY ("incident_service_response_id")
);

INSERT INTO "incident_service_responses" (
  "incident_service_response_id", "incident_id", "service", "status", "resolved_at", "updated_at"
)
SELECT gen_random_uuid(), i."incident_id", s."service",
  CASE WHEN i."status" IN ('RESOLVED', 'CLOSED') THEN 'RESOLVED'::"ServiceResponseStatus" ELSE 'RESPONDING'::"ServiceResponseStatus" END,
  CASE WHEN i."status" IN ('RESOLVED', 'CLOSED') THEN i."updated_at" ELSE NULL END,
  i."updated_at"
FROM "incidents" i
CROSS JOIN LATERAL unnest(
  CASE WHEN cardinality(i."requested_services") > 0 THEN i."requested_services"
  ELSE ARRAY[
    CASE
      WHEN lower((SELECT "type_name" FROM "incident_types" WHERE "type_id" = i."type_id")) ~ '(fire|bfp)' THEN 'FIRE'::"ResponseService"
      WHEN lower((SELECT "type_name" FROM "incident_types" WHERE "type_id" = i."type_id")) ~ '(medical|med|ambulance|ems|health)' THEN 'MEDICAL'::"ResponseService"
      WHEN lower((SELECT "type_name" FROM "incident_types" WHERE "type_id" = i."type_id")) ~ '(police|pnp|security|crime)' THEN 'POLICE'::"ResponseService"
      ELSE 'HAZARD'::"ResponseService"
    END
  ] END
) AS s("service")
ON CONFLICT DO NOTHING;

CREATE TABLE "notification_outbox" (
  "notification_outbox_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("notification_outbox_id")
);

CREATE TABLE "asset_cleanup_jobs" (
  "asset_cleanup_job_id" UUID NOT NULL,
  "public_id" TEXT NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "asset_cleanup_jobs_pkey" PRIMARY KEY ("asset_cleanup_job_id")
);

CREATE UNIQUE INDEX "incident_service_responses_incident_id_service_key" ON "incident_service_responses"("incident_id", "service");
CREATE INDEX "incident_service_responses_service_status_idx" ON "incident_service_responses"("service", "status");
CREATE INDEX "notification_outbox_status_next_attempt_at_idx" ON "notification_outbox"("status", "next_attempt_at");
CREATE UNIQUE INDEX "asset_cleanup_jobs_public_id_key" ON "asset_cleanup_jobs"("public_id");
CREATE INDEX "asset_cleanup_jobs_status_next_attempt_at_idx" ON "asset_cleanup_jobs"("status", "next_attempt_at");
CREATE INDEX "incidents_merged_into_id_idx" ON "incidents"("merged_into_id");

ALTER TABLE "incident_service_responses" ADD CONSTRAINT "incident_service_responses_incident_id_fkey"
FOREIGN KEY ("incident_id") REFERENCES "incidents"("incident_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_service_responses" ADD CONSTRAINT "incident_service_responses_resolved_by_fkey"
FOREIGN KEY ("resolved_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_merged_into_id_fkey"
FOREIGN KEY ("merged_into_id") REFERENCES "incidents"("incident_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_merged_by_fkey"
FOREIGN KEY ("merged_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
