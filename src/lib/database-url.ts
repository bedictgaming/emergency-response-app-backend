const LEGACY_SSL_MODES = new Set(['prefer', 'require', 'verify-ca']);

/**
 * Keep node-postgres on its current strict certificate and hostname checking.
 * pg v9 will change the meaning of several libpq-compatible SSL modes, so the
 * application makes the intended secure behavior explicit now.
 */
export function normalizeDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error('DATABASE_URL is required');

  const url = new URL(value);
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode && LEGACY_SSL_MODES.has(sslMode)) {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
}
