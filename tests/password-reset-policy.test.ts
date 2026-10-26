import { expect, it } from 'vitest';
import { resetPasswordSchema } from '@/validation/auth/password-reset.schema';

const valid = (password: string) => resetPasswordSchema.safeParse({ body: { token: 'a'.repeat(64), password } }).success;
it.each(['DemoSafe11!', 'DemoSafe111!', `Aa1${'x'.repeat(125)}`])('accepts a synthetic password of %s within the approved 11–128 range', password => {
  expect(valid(password)).toBe(true);
});
it.each(['DemoSafe1!', '', `Aa1${'x'.repeat(126)}`, 'lowercase11!', 'UPPERCASE11!', 'NoDigitsHere!'])('retains length and character-class rejection for synthetic input %s', password => {
  expect(valid(password)).toBe(false);
});
it('does not relax token or request-body requirements with the shorter minimum', () => {
  for (const body of [{ password: 'DemoSafe11!' }, { token: 'short', password: 'DemoSafe11!' }, { token: 'a'.repeat(64) }])
    expect(resetPasswordSchema.safeParse({ body }).success).toBe(false);
});
