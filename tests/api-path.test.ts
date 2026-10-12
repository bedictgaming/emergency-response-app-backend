import { describe, expect, it } from 'vitest';
import { isApiPath } from '@/lib/api-path';

describe('API security-boundary path classification', () => {
  it.each(['/api', '/API', '/Api', '/aPi', '/apI', '/APi', '/aPI', '/ApI'])(
    'covers the exact mount and every child regardless of casing: %s', (prefix) => {
      for (const suffix of ['', '/', '/auth/v1/me', '/AUTH/v1/ME', '/missing', '//missing']) {
        const path = prefix + suffix;
        expect(isApiPath(path)).toBe(true);
        expect(path).toBe(prefix + suffix);
      }
    });

  it.each(['', '/', '/healthz', '/readyz', '/apix', '/API-extra/auth', '/apis/auth',
    '/other/api/auth', '/api%2Fauth', '/%61pi/auth', '/api;param/auth', '//api/auth'])(
    'does not decode or overmatch unrelated paths: %s', (path) => {
      expect(isApiPath(path)).toBe(false);
    });
});
