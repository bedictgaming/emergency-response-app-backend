-- Earlier deployed databases acquired these objects outside the migration
-- chain. A fresh database needs them before the hardening/index migrations.
-- IF NOT EXISTS keeps this safe when applied later to an already-populated
-- installation; do not rewrite previously applied migration checksums.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BarangayStatus') THEN
    CREATE TYPE "BarangayStatus" AS ENUM ('ACTIVE', 'INACTIVE');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "barangays" (
  "barangay_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "status" "BarangayStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "barangays_pkey" PRIMARY KEY ("barangay_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "barangays_name_key" ON "barangays"("name");

ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "barangay_id" UUID;
CREATE INDEX IF NOT EXISTS "incidents_barangay_id_idx" ON "incidents"("barangay_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incidents_barangay_id_fkey') THEN
    ALTER TABLE "incidents" ADD CONSTRAINT "incidents_barangay_id_fkey"
      FOREIGN KEY ("barangay_id") REFERENCES "barangays"("barangay_id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
