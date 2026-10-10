import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('guards case-folding collisions, preserves Google sub, backfills passwords without copying hashes', () => {
  const sql = readFileSync('prisma/migrations/20261010090000_auth_identities/migration.sql', 'utf8');
  expect(sql).toContain('BEGIN;'); expect(sql).toContain('COMMIT;');
  expect(sql).toContain('LOCK TABLE "User", "OAuthAccount"');
  expect(sql.indexOf('RAISE EXCEPTION')).toBeLessThan(sql.indexOf('UPDATE "User"'));
  expect(sql).toContain('GROUP BY lower(btrim(email)) HAVING count(*) > 1');
  expect(sql).toContain('"User_normalized_email_key"'); expect(sql).toContain('"provider", "provider_user_id"');
  expect(sql).toContain('a."providerAccountId"'); expect(sql).toContain("id, 'password', id, email");
  expect(sql).not.toMatch(/DROP TABLE|DELETE FROM|(?:SELECT|,)\s+(?:"password"|password)\s*(?:,|FROM)/i);
});
