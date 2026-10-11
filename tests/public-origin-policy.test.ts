import { describe, expect, it } from 'vitest';
import { exactOrigin, selectPublicOrigin } from '@/lib/public-origin-policy';
const current = 'https://cordova-emergency-response.site';
const old = 'https://cordova-emergency-response.vercel.app';
const trusted = new Set([current, old]);
describe('dual-domain public origin policy', () => {
  it('selects only the authenticated, exactly trusted gateway origin', () => {
    for (const origin of trusted) expect(selectPublicOrigin(origin, trusted, current, old)).toBe(origin);
    for (const origin of ['https://evil.invalid', current + '.evil.invalid', current + '/path', null])
      expect(selectPublicOrigin(origin, trusted, current, old)).toBe(current);
    expect(selectPublicOrigin(undefined, trusted, current, old)).toBe(old);
    expect(selectPublicOrigin(undefined, trusted, current)).toBe(current);
    expect(selectPublicOrigin(undefined, new Set([current]), current, old)).toBe(current);
  });
  it('rejects wildcard, credentials, insecure production URL, paths, queries and fragments', () => {
    for (const origin of ['https://*.example.test', 'https://user:password@example.test', current + '/api', current + '?x=1', current + '#x', 'http://example.test', 'not-a-url'])
      expect(() => exactOrigin(origin, true)).toThrow();
    expect(exactOrigin(current + '/', true)).toBe(current);
    expect(exactOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });
});
