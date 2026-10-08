import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), session: vi.fn(), count: vi.fn(), findProvider: vi.fn(),
  createLink: vi.fn(), deleteLinks: vi.fn(), findIntent: vi.fn(), createIntent: vi.fn(), claimIntent: vi.fn(),
  deleteIntent: vi.fn(), deleteIntents: vi.fn(), revoke: vi.fn(), audit: vi.fn(), transaction: vi.fn(), lock: vi.fn(), verify: vi.fn() }));
vi.mock('@/config/env', () => ({ ENV: { GOOGLE_ACCOUNT_LINKING_ENABLED: true, GOOGLE_CLIENT_ID: 'synthetic-client',
  GOOGLE_CLIENT_SECRET: 'synthetic-secret', NODE_ENV: 'test', BACKEND_URL: 'http://localhost:8000' } }));
vi.mock('@/utils/password', () => ({ verifyPassword: mocks.verify, PasswordProcessingBusy: class extends Error {} }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: mocks.user }, $transaction: mocks.transaction } }));
import { ENV } from '@/config/env';
import { beginGoogleLink, claimGoogleLink, completeGoogleLink, googleLinkStatus, unlinkGoogle, safeGoogleLinkError } from '@/services/auth/google-link-service';
import { linkDigest, pkceChallenge, verifiedGoogleLinkIdentity, exchangeGoogleLinkCode } from '@/services/auth/google-link-provider';
import type { JwtPayload } from '@/lib/jwt';

const actor: JwtPayload = { sub: 'synthetic-citizen', role: 'USER', type: 'access', sessionId: 'synthetic-session' };
const user = { id: actor.sub, email: 'synthetic@gmail.com', password: 'synthetic-stored-hash', role: 'USER', status: 'ACTIVE', emailVerified: null };
const state = `link.${'a'.repeat(43)}`, verifier = 'b'.repeat(43), consumedAt = new Date();
const intent = () => ({ id: 'intent', userId: actor.sub, sessionId: actor.sessionId, stateHash: linkDigest(state),
  pkceChallenge: pkceChallenge(verifier), passwordFingerprint: linkDigest(user.password), email: user.email,
  consumedAt: null as Date | null, expiresAt: new Date(Date.now() + 300_000) });
const claim = { id: 'intent', consumedAt };
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllGlobals(); (ENV as unknown as { GOOGLE_ACCOUNT_LINKING_ENABLED: boolean }).GOOGLE_ACCOUNT_LINKING_ENABLED = true;
  mocks.user.mockResolvedValue(user); mocks.session.mockResolvedValue({ id: actor.sessionId }); mocks.verify.mockResolvedValue(true);
  mocks.count.mockResolvedValue(0); mocks.findProvider.mockResolvedValue(null); mocks.findIntent.mockResolvedValue(intent());
  mocks.claimIntent.mockResolvedValue({ count: 1 }); mocks.deleteLinks.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation(callback => callback({ $queryRaw: mocks.lock, user: { findUnique: mocks.user },
    token: { findFirst: mocks.session, updateMany: mocks.revoke },
    googleLinkIntent: { findUnique: mocks.findIntent, create: mocks.createIntent, updateMany: mocks.claimIntent, delete: mocks.deleteIntent, deleteMany: mocks.deleteIntents },
    oAuthAccount: { count: mocks.count, findUnique: mocks.findProvider, create: mocks.createLink, deleteMany: mocks.deleteLinks }, auditLog: { create: mocks.audit } }));
});

describe('explicit citizen Google connection', () => {
  it('requires password proof and stores only state/password digests and the PKCE challenge', async () => {
    const result = await beginGoogleLink(actor, 'private-synthetic-password');
    expect(mocks.verify).toHaveBeenCalledWith('private-synthetic-password', user.password);
    const url = new URL(result.authorizationUrl);
    expect(url.origin).toBe('https://accounts.google.com'); expect(url.searchParams.get('state')).toBe(result.state);
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge(result.verifier));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8000/api/auth/v1/google/callback');
    const data = mocks.createIntent.mock.calls[0][0].data;
    expect(data).toMatchObject({ stateHash: linkDigest(result.state), userId: actor.sub, sessionId: actor.sessionId, email: user.email,
      passwordFingerprint: linkDigest(user.password) });
    const serialized = JSON.stringify(data);
    for (const secret of [result.state, result.verifier, user.password, 'private-synthetic-password']) expect(serialized).not.toContain(secret);
    expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(295_000);
    expect(mocks.createLink).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it.each(['ADMIN', 'DISPATCHER', 'RESPONDER'])('denies role %s at the backend', async role => {
    await expect(beginGoogleLink({ ...actor, role }, 'password')).rejects.toMatchObject({ code: 403 });
    await expect(googleLinkStatus({ ...actor, role })).rejects.toMatchObject({ code: 403 });
    expect(mocks.verify).not.toHaveBeenCalled(); expect(mocks.createIntent).not.toHaveBeenCalled();
  });
  it('rechecks current role after password confirmation', async () => {
    mocks.user.mockResolvedValueOnce(user).mockResolvedValue({ ...user, role: 'ADMIN' });
    await expect(beginGoogleLink(actor, 'password')).rejects.toMatchObject({ code: 403 });
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });
  it('fails closed when disabled without consulting the new table', async () => {
    (ENV as unknown as { GOOGLE_ACCOUNT_LINKING_ENABLED: boolean }).GOOGLE_ACCOUNT_LINKING_ENABLED = false;
    expect(await googleLinkStatus(actor)).toEqual({ available: false, linked: false, hasPassword: false });
    await expect(beginGoogleLink(actor, 'password')).rejects.toMatchObject({ code: 503 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('rejects a wrong password without an intent or provider call', async () => {
    mocks.verify.mockResolvedValue(false);
    await expect(beginGoogleLink(actor, 'wrong')).rejects.toMatchObject({ reason: 'wrong_password' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('refuses disconnecting a Google-only account with no password fallback', async () => {
    mocks.user.mockResolvedValue({ ...user, password: null });
    await expect(unlinkGoogle(actor, 'password')).rejects.toMatchObject({ reason: 'password_required' });
    expect(mocks.deleteLinks).not.toHaveBeenCalled();
  });
  it('refuses replacing an existing connection', async () => {
    mocks.count.mockResolvedValue(1);
    await expect(beginGoogleLink(actor, 'password')).rejects.toMatchObject({ code: 409 });
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });
  it.each(['consumed', 'expired', 'session', 'state', 'verifier', 'password', 'email'])('rejects changed/replayed intent: %s', async change => {
    const row = intent();
    if (change === 'consumed') row.consumedAt = new Date();
    if (change === 'expired') row.expiresAt = new Date(0);
    if (change === 'session') row.sessionId = 'other-session';
    if (change === 'state') row.stateHash = 'other';
    if (change === 'verifier') row.pkceChallenge = 'other';
    if (change === 'password') row.passwordFingerprint = 'other';
    if (change === 'email') row.email = 'other@gmail.com';
    mocks.findIntent.mockResolvedValue(row);
    await expect(claimGoogleLink(actor, state, verifier)).rejects.toMatchObject({ reason: 'expired' });
    expect(mocks.claimIntent).not.toHaveBeenCalled(); expect(mocks.createLink).not.toHaveBeenCalled();
  });
  it('claims once before provider exchange', async () => {
    expect(await claimGoogleLink(actor, state, verifier)).toMatchObject({ id: 'intent', consumedAt: expect.any(Date) });
    mocks.claimIntent.mockResolvedValue({ count: 0 });
    await expect(claimGoogleLink(actor, state, verifier)).rejects.toMatchObject({ reason: 'expired' });
  });
  it('rejects a revoked/rotated/logout session even with a valid intent', async () => {
    mocks.session.mockResolvedValue(null);
    await expect(claimGoogleLink(actor, state, verifier)).rejects.toMatchObject({ reason: 'expired' });
    await expect(completeGoogleLink(actor, claim, { sub: 'google-sub', email: user.email })).rejects.toMatchObject({ reason: 'expired' });
    expect(mocks.createLink).not.toHaveBeenCalled();
  });
  it('adds only the provider binding and audit, not an account, session, role or verification', async () => {
    mocks.findIntent.mockResolvedValue({ ...intent(), consumedAt });
    await completeGoogleLink(actor, claim, { sub: 'google-sub', email: user.email });
    expect(mocks.createLink).toHaveBeenCalledWith({ data: { userId: user.id, provider: 'google', providerAccountId: 'google-sub' } });
    expect(mocks.audit).toHaveBeenCalledWith({ data: { actorId: user.id, action: 'GOOGLE_ACCOUNT_LINKED', entityType: 'User', entityId: user.id,
      metadata: { provider: 'google', method: 'password-confirmed' } } });
    expect(mocks.revoke).not.toHaveBeenCalled(); expect(mocks.deleteIntent).toHaveBeenCalled();
  });
  it('refuses a different Google email', async () => {
    mocks.findIntent.mockResolvedValue({ ...intent(), consumedAt });
    await expect(completeGoogleLink(actor, claim, { sub: 'google-sub', email: 'other@gmail.com' })).rejects.toMatchObject({ reason: 'email_mismatch' });
    expect(mocks.createLink).not.toHaveBeenCalled();
  });
  it('refuses an identity belonging to any other user without exposing that user', async () => {
    mocks.findIntent.mockResolvedValue({ ...intent(), consumedAt }); mocks.findProvider.mockResolvedValue({ userId: 'other' });
    await expect(completeGoogleLink(actor, claim, { sub: 'google-sub', email: user.email })).rejects.toMatchObject({ reason: 'conflict' });
    expect(mocks.createLink).not.toHaveBeenCalled(); expect(mocks.deleteLinks).not.toHaveBeenCalled();
  });
  it('maps a concurrent unique collision to conflict, never merging', async () => {
    mocks.findIntent.mockResolvedValue({ ...intent(), consumedAt }); mocks.createLink.mockRejectedValue({ code: 'P2002' });
    await expect(completeGoogleLink(actor, claim, { sub: 'google-sub', email: user.email })).rejects.toMatchObject({ code: 409 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('disconnects only the actor Google link, revokes all sessions and audits', async () => {
    await unlinkGoogle(actor, 'password');
    expect(mocks.deleteLinks).toHaveBeenCalledWith({ where: { userId: user.id, provider: 'google' } });
    expect(mocks.revoke).toHaveBeenCalledWith({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(mocks.audit).toHaveBeenCalled(); expect(mocks.deleteIntents).toHaveBeenCalled();
  });
  it('does not expose raw provider, DB or credential errors', () => {
    expect(JSON.stringify(safeGoogleLinkError(new Error('private-token-secret-email')))).not.toContain('private-token');
  });
});

describe('trusted Google identity and bounded provider exchange', () => {
  it('aborts a stalled provider exchange at the shared deadline without retry', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('private-provider-timeout')), { once: true });
      }));
      vi.stubGlobal('fetch', fetcher);
      const outcome = expect(exchangeGoogleLinkCode('code', verifier)).rejects.toThrow('Google linking could not be completed');
      await vi.advanceTimersByTimeAsync(10_000); await outcome;
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it.each([false, 'true', undefined])('requires strict verified ownership: %s', email_verified => {
    expect(verifiedGoogleLinkIdentity({ sub: 'google-sub', email: user.email, email_verified })).toBeNull();
  });
  it('permits only authoritative Gmail or matching Workspace, with stable sub', () => {
    expect(verifiedGoogleLinkIdentity({ sub: 'google-sub', email: ' Synthetic@Gmail.com ', email_verified: true })).toEqual({ sub: 'google-sub', email: user.email });
    expect(verifiedGoogleLinkIdentity({ sub: 'google-sub', email: 'synthetic@example.test', email_verified: true })).toBeNull();
    expect(verifiedGoogleLinkIdentity({ sub: 'google-sub', email: 'synthetic@example.test', email_verified: true, hd: 'example.test' })).not.toBeNull();
    expect(verifiedGoogleLinkIdentity({ sub: '', email: user.email, email_verified: true })).toBeNull();
  });
  it('exchanges code once with PKCE then uses authenticated Google userinfo; persists no tokens', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'synthetic-google-token', token_type: 'Bearer' }))
      .mockResolvedValueOnce(Response.json({ sub: 'google-sub', email: user.email, email_verified: true }));
    vi.stubGlobal('fetch', fetcher);
    expect(await exchangeGoogleLinkCode('synthetic-code', verifier)).toEqual({ sub: 'google-sub', email: user.email });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    expect(fetcher.mock.calls[0][1].body.get('code_verifier')).toBe(verifier);
    expect(fetcher.mock.calls[1][0]).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer synthetic-google-token');
    expect(fetcher.mock.calls.every(call => call[1].redirect === 'error')).toBe(true);
  });
  it.each([Response.json({ secret: 'private' }, { status: 401 }), new Response('x'.repeat(16_385)), Response.json({ access_token: 'secret' })])('rejects unexpected receipt without fallback', async receipt => {
    const fetcher = vi.fn().mockResolvedValue(receipt); vi.stubGlobal('fetch', fetcher);
    await expect(exchangeGoogleLinkCode('code', verifier)).rejects.toThrow('Google linking could not be completed');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

