-- Preserve all prior decisions and immutable audit history. Existing flags
-- originated under the Main-review workflow; only new authorized decisions
-- explicitly switch their provenance to DEPARTMENT.
BEGIN;
ALTER TABLE "incident_review_flags"
  ADD COLUMN "review_authority" VARCHAR(16) NOT NULL DEFAULT 'MAIN',
  ADD CONSTRAINT "incident_review_flags_review_authority_check"
    CHECK ("review_authority" IN ('MAIN', 'DEPARTMENT'));
COMMIT;
