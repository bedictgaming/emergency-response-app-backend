import { describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from '@/utils/password';
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from '@/lib/jwt';

describe('credential primitives', () => {
  it('bounds CPU concurrency and queued work rather than starting every derivation', async () => {
    const { default: crypto } = await import('node:crypto');
    const callbacks: Array<(error: Error | null, key: Buffer) => void> = [];
    const spy = vi.spyOn(crypto, 'pbkdf2').mockImplementation((_password, _salt, _iterations, _length, _digest, callback) => { callbacks.push(callback); });
    try {
      const admitted = Array.from({ length: 34 }, () => hashPassword('SyntheticPassword'));
      await expect(hashPassword('OverflowPassword')).rejects.toMatchObject({ status: 503 });
      expect(spy).toHaveBeenCalledTimes(2);
      for (let wave = 0; wave < 17; wave++) {
        callbacks.splice(0).forEach(callback => callback(null, Buffer.alloc(64)));
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      await Promise.all(admitted); expect(spy).toHaveBeenCalledTimes(34);
    } finally { spy.mockRestore(); }
  });
  it('retains legacy PBKDF2 hashes and fails safely on malformed stored data', async () => {
    for (const stored of ['', 'broken', 'a:1000000000000:bad', 'ab:0:cd']) expect(await verifyPassword('password', stored)).toBe(false);
    const { default: crypto } = await import('node:crypto');
    const salt = '1234567890abcdef1234567890abcdef';
    const hash = crypto.pbkdf2Sync('LegacyPassword', salt, 120000, 64, 'sha512').toString('hex');
    expect(await verifyPassword('LegacyPassword', `${salt}:120000:${hash}`)).toBe(true);
  });
  it('allows event-loop I/O while password derivation runs', async () => {
    let settled = false;
    const work = hashPassword('StrongPassword123').then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false); await work;
  });
  it('hashes passwords with a unique salt and verifies safely', async () => {
    const first = await hashPassword('StrongPassword123');
    const second = await hashPassword('StrongPassword123');
    expect(first).not.toBe(second);
    expect(await verifyPassword('StrongPassword123', first)).toBe(true);
    expect(await verifyPassword('WrongPassword123', first)).toBe(false);
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
