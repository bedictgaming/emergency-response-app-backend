BEGIN;

-- Additive only. No migration/backfill/redaction of existing audit data.
CREATE TABLE "report_request_contexts" (
  "audit_log_id" UUID NOT NULL,
  "captured_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "ip_address" VARCHAR(45),
  "user_agent" VARCHAR(384),
  CONSTRAINT "report_request_contexts_pkey" PRIMARY KEY ("audit_log_id"),
  CONSTRAINT "report_request_contexts_audit_log_id_fkey" FOREIGN KEY ("audit_log_id")
    REFERENCES "audit_logs"("audit_log_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "report_request_contexts_expiry_check" CHECK ("expires_at" = "captured_at" + INTERVAL '720 hours'),
  CONSTRAINT "report_request_contexts_nonempty_check" CHECK ("ip_address" IS NOT NULL OR "user_agent" IS NOT NULL)
);

CREATE INDEX "report_request_contexts_expires_at_audit_log_id_idx"
  ON "report_request_contexts"("expires_at", "audit_log_id");

COMMIT;
