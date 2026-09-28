import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '@/utils/password';
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from '@/lib/jwt';

describe('credential primitives', () => {
  it('hashes passwords with a unique salt and verifies safely', () => {
    const first = hashPassword('StrongPassword123');
    const second = hashPassword('StrongPassword123');
    expect(first).not.toBe(second);
    expect(verifyPassword('StrongPassword123', first)).toBe(true);
    expect(verifyPassword('WrongPassword123', first)).toBe(false);
  });

  it('keeps access and refresh token purposes separate', () => {
    const access = signAccessToken('user-1', 'USER', '15m', 'session-1');
    const refresh = signRefreshToken('user-1', 'USER', '7d');
    expect(verifyAccessToken(access)?.sub).toBe('user-1');
    expect(verifyAccessToken(access)?.sessionId).toBe('session-1');
    expect(verifyRefreshToken(access)).toBeNull();
    expect(verifyAccessToken(refresh)).toBeNull();
    expect(verifyRefreshToken(refresh)?.sub).toBe('user-1');
  });
});
