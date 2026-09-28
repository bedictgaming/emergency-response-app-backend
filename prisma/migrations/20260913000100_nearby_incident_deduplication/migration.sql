-- Speeds up the authoritative nearby-active-incident candidate lookup.
CREATE INDEX "incidents_barangay_id_type_id_status_reported_at_idx"
ON "incidents"("barangay_id", "type_id", "status", "reported_at");
