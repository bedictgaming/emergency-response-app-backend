/** Exact origins only: no wildcard, credentials, paths, queries or fragments. */
export function exactOrigin(value: string, production = false): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:')
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || url.hostname.includes('*')) throw new Error('Invalid public origin configuration');
  return url.origin;
}

export function selectPublicOrigin(verified: unknown, trusted: ReadonlySet<string>, canonical: string, legacy?: string): string {
  if (typeof verified === 'string' && trusted.has(verified)) return verified;
  // Old signed gateways have no origin metadata. Preserve their existing OAuth
  // callback through the rolling release and for already-open old bundles.
  if (verified === undefined && legacy && trusted.has(legacy)) return legacy;
  return canonical;
}
