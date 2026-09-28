import { describe, expect, it } from 'vitest';
import { normalizeDatabaseUrl } from '@/lib/database-url';

describe('database URL normalization', () => {
  it('makes legacy SSL mode behavior explicitly verify-full', () => {
    const normalized = normalizeDatabaseUrl(
      'postgresql://user:password@example.test/app?sslmode=require&channel_binding=require',
    );
    const parsed = new URL(normalized);

    expect(parsed.searchParams.get('sslmode')).toBe('verify-full');
    expect(parsed.searchParams.get('channel_binding')).toBe('require');
  });

  it('does not weaken an explicitly configured SSL mode', () => {
    const normalized = normalizeDatabaseUrl(
      'postgresql://user:password@example.test/app?sslmode=no-verify',
    );
    expect(new URL(normalized).searchParams.get('sslmode')).toBe('no-verify');
  });
});
