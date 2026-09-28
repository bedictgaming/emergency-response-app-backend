-- Dashboard lists sort by report time and department authorization checks
-- membership in requested_services. These indexes prevent full incident-table
-- scans as production history grows.
CREATE INDEX IF NOT EXISTS "incidents_reported_at_idx"
  ON "incidents" ("reported_at" DESC);

CREATE INDEX IF NOT EXISTS "incidents_requested_services_idx"
  ON "incidents" USING GIN ("requested_services");
