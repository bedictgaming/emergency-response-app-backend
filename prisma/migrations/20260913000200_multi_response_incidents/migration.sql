CREATE TYPE "ResponseService" AS ENUM ('FIRE', 'MEDICAL', 'POLICE', 'HAZARD');

ALTER TABLE "incidents"
ADD COLUMN "requested_services" "ResponseService"[] NOT NULL DEFAULT ARRAY[]::"ResponseService"[];

CREATE INDEX "incidents_barangay_id_status_reported_at_idx"
ON "incidents"("barangay_id", "status", "reported_at");
