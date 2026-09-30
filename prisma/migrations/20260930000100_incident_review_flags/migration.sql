CREATE TYPE "IncidentReviewStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

CREATE TABLE "incident_review_flags" (
    "review_flag_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "department" "Department" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "IncidentReviewStatus" NOT NULL DEFAULT 'PENDING',
    "flagged_by" TEXT,
    "reviewed_by" TEXT,
    "review_notes" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "incident_review_flags_pkey" PRIMARY KEY ("review_flag_id")
);
CREATE UNIQUE INDEX "incident_review_flags_incident_id_department_key" ON "incident_review_flags"("incident_id", "department");
CREATE INDEX "incident_review_flags_status_updated_at_idx" ON "incident_review_flags"("status", "updated_at");
ALTER TABLE "incident_review_flags" ADD CONSTRAINT "incident_review_flags_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("incident_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_review_flags" ADD CONSTRAINT "incident_review_flags_flagged_by_fkey" FOREIGN KEY ("flagged_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "incident_review_flags" ADD CONSTRAINT "incident_review_flags_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
