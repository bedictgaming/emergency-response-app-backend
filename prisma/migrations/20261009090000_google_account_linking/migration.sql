-- Additive only: no existing account, provider link, token or report is rewritten.
CREATE TABLE "GoogleLinkIntent" (
  "id" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "passwordFingerprint" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "pkceChallenge" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoogleLinkIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoogleLinkIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GoogleLinkIntent_stateHash_key" ON "GoogleLinkIntent"("stateHash");
CREATE UNIQUE INDEX "GoogleLinkIntent_userId_key" ON "GoogleLinkIntent"("userId");
CREATE INDEX "GoogleLinkIntent_expiresAt_idx" ON "GoogleLinkIntent"("expiresAt");
