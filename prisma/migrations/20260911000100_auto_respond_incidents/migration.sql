-- New emergency reports no longer wait in an administrative verification
-- queue. They are accepted into the responding workflow immediately.
ALTER TABLE "incidents"
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE',
  ALTER COLUMN "verification_status" SET DEFAULT 'VERIFIED';

-- Move existing non-rejected reports out of the retired pending state.
UPDATE "incidents"
SET
  "status" = 'ACTIVE',
  "verification_status" = 'VERIFIED',
  "verified_at" = COALESCE("verified_at", CURRENT_TIMESTAMP),
  "updated_at" = CURRENT_TIMESTAMP
WHERE "status" = 'OPEN'
  AND "verification_status" <> 'REJECTED';
