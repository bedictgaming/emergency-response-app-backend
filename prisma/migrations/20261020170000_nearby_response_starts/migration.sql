-- Add an explicit response-start receipt; preserve all prior review decisions.
CREATE TABLE "incident_nearby_response_starts" (
  "review_id" UUID NOT NULL,
  "expected_review_version" INTEGER NOT NULL,
  "started_by" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "legacy_admission" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "incident_nearby_response_starts_pkey" PRIMARY KEY ("review_id"),
  CONSTRAINT "nearby_response_start_positive_version" CHECK ("expected_review_version" > 0),
  CONSTRAINT "incident_nearby_response_starts_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "incident_nearby_reviews"("review_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "incident_nearby_response_starts_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- These decisions already admitted their lane under the previous workflow.
-- This is a compatibility receipt, not a claim that a crew physically departed.
INSERT INTO "incident_nearby_response_starts" ("review_id", "expected_review_version", "started_by", "started_at", "legacy_admission")
SELECT "review_id", "version", "reviewed_by", COALESCE("reviewed_at", "created_at"), true
FROM "incident_nearby_reviews"
WHERE "status" = 'ACKNOWLEDGED';
