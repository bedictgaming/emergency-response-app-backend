import { expect, it } from 'vitest';
import passport from '@/lib/passport';

it('passes the verified link verifier to the actual Passport code exchange, not ordinary sign-in', () => {
  const strategy = (passport as unknown as { _strategy(name: string): { tokenParams(options: { linkVerifier?: string }): object } })._strategy('google');
  expect(strategy.tokenParams({ linkVerifier: 'synthetic-verifier' })).toEqual({ code_verifier: 'synthetic-verifier' });
  expect(strategy.tokenParams({})).toEqual({});
});
