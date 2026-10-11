import { expect, it, vi } from 'vitest';
import passport from '@/lib/passport';
type Strategy = {
  _callbackURL: string;
  _oauth2: { getOAuthAccessToken: (code: string, params: Record<string, string>, done: (error: Error) => void) => void };
  authenticate: (request: object, options: object) => void;
  redirect: (url: string) => void;
  error: (error: Error) => void;
};
it('the installed Passport strategy uses the per-request callback for authorization and code exchange without shared mutation', () => {
  const shared = (passport as unknown as { _strategy: (name: string) => Strategy })._strategy('google');
  const original = shared._callbackURL;
  const strategy = Object.create(shared) as Strategy;
  strategy.redirect = vi.fn(); strategy.error = vi.fn();
  const exchange = vi.fn((_code: string, _params: Record<string, string>, done: (error: Error) => void) => done(new Error('synthetic-stop-before-provider')));
  strategy._oauth2 = { ...shared._oauth2, getOAuthAccessToken: exchange };
  for (const origin of ['https://cordova-emergency-response.site', 'https://cordova-emergency-response.vercel.app']) {
    const callbackURL = origin + '/api/auth/v1/google/callback';
    strategy.authenticate({ query: {} }, { callbackURL, scope: ['profile', 'email'], state: 'synthetic-state' });
    expect(new URL((strategy.redirect as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).searchParams.get('redirect_uri')).toBe(callbackURL);
    strategy.authenticate({ query: { code: 'synthetic-code' } }, { callbackURL, linkVerifier: 'synthetic-verifier' });
    expect(exchange).toHaveBeenLastCalledWith('synthetic-code', expect.objectContaining({ redirect_uri: callbackURL, code_verifier: 'synthetic-verifier' }), expect.any(Function));
    expect(shared._callbackURL).toBe(original);
  }
});
