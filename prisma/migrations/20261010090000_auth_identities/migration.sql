-- Gate: authenticate an encrypted backup of the exact target before applying.
BEGIN;
LOCK TABLE "User", "OAuthAccount" IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "User" WHERE email IS NOT NULL GROUP BY lower(btrim(email)) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Identity migration requires review: conflicting normalized emails';
  END IF;
  IF EXISTS (SELECT 1 FROM "OAuthAccount" GROUP BY "userId", provider HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM "OAuthAccount" WHERE provider <> 'google') THEN
    RAISE EXCEPTION 'Identity migration requires review: legacy provider bindings';
  END IF;
END $$;
UPDATE "User" SET email = lower(btrim(email)) WHERE email IS NOT NULL AND email <> lower(btrim(email));
-- Prisma cannot express this functional index; retain it on all writers.
CREATE UNIQUE INDEX "User_normalized_email_key" ON "User" (lower(btrim(email))) WHERE email IS NOT NULL;
CREATE TABLE "auth_identities" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_user_id" TEXT NOT NULL,
  "email" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "auth_identities_provider_check" CHECK (provider IN ('password', 'google')),
  CONSTRAINT "auth_identities_password_subject_check" CHECK (provider <> 'password' OR provider_user_id = user_id)
);
CREATE UNIQUE INDEX "auth_identities_provider_provider_user_id_key" ON "auth_identities"("provider", "provider_user_id");
CREATE UNIQUE INDEX "auth_identities_user_id_provider_key" ON "auth_identities"("user_id", "provider");
INSERT INTO "auth_identities" (id, user_id, provider, provider_user_id, email)
  SELECT 'legacy-google:' || a.id, a."userId", a.provider, a."providerAccountId", u.email
  FROM "OAuthAccount" a JOIN "User" u ON u.id = a."userId";
INSERT INTO "auth_identities" (id, user_id, provider, provider_user_id, email, created_at)
  SELECT 'legacy-password:' || id, id, 'password', id, email, "createdAt"
  FROM "User" WHERE password IS NOT NULL AND password <> '';
-- Legacy OAuthAccount is preserved for review, not a live authentication fallback.
COMMIT;
