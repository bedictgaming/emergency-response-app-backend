-- Additive and opt-in. No existing reports are reclassified or removed.
CREATE TYPE "NearbyReviewStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'REJECTED');
CREATE TABLE "incident_nearby_reviews" (
  "review_id" UUID NOT NULL,
  "incident_id" UUID NOT NULL,
  "parent_incident_id" UUID NOT NULL,
  "service" "ResponseService" NOT NULL,
  "status" "NearbyReviewStatus" NOT NULL DEFAULT 'PENDING',
  "version" INTEGER NOT NULL DEFAULT 1,
  "reason" TEXT,
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "incident_nearby_reviews_pkey" PRIMARY KEY ("review_id"),
  CONSTRAINT "nearby_review_not_self" CHECK ("incident_id" <> "parent_incident_id"),
  CONSTRAINT "nearby_review_version_positive" CHECK ("version" > 0),
  CONSTRAINT "nearby_review_rejection_reason" CHECK ("status" <> 'REJECTED' OR length(trim("reason")) BETWEEN 10 AND 500),
  CONSTRAINT "incident_nearby_reviews_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("incident_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "incident_nearby_reviews_parent_incident_id_fkey" FOREIGN KEY ("parent_incident_id") REFERENCES "incidents"("incident_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "incident_nearby_reviews_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "incident_nearby_reviews_incident_id_service_key" ON "incident_nearby_reviews"("incident_id", "service");
CREATE INDEX "incident_nearby_reviews_service_status_created_at_idx" ON "incident_nearby_reviews"("service", "status", "created_at");
CREATE INDEX "incident_nearby_reviews_parent_incident_id_status_idx" ON "incident_nearby_reviews"("parent_incident_id", "status");
