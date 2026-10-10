import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), transaction: vi.fn(), lock: vi.fn(), current: vi.fn(), verify: vi.fn(),
  upsert: vi.fn(), intent: vi.fn(), claim: vi.fn(), deleteIntent: vi.fn(), binding: vi.fn(), create: vi.fn(), remove: vi.fn(), revoke: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: mocks.lookup }, $transaction: mocks.transaction } }));
vi.mock('@/utils/password', () => ({ verifyPassword: mocks.verify, PasswordProcessingBusy: class extends Error {} }));
vi.mock('@/config/env', () => ({ ENV: { GOOGLE_CLIENT_ID: 'synthetic-client', BACKEND_URL: 'https://api.example.test' } }));
import { BeginGoogleLinkService, ClaimGoogleLinkService, CompleteGoogleLinkService, GetLoginMethodsService, UnlinkGoogleService } from '@/services/auth/google-link-service';
const actor = { sub: 'user', sessionId: 'session' };
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const challenge = (value: string) => crypto.createHash('sha256').update(value).digest('base64url');
const state = 'link.' + 'a'.repeat(43), verifier = 'b'.repeat(43);
const passwordIdentity = { provider: 'password', providerUserId: actor.sub, userId: actor.sub };
const googleIdentity = { provider: 'google', providerUserId: 'google-sub', userId: actor.sub, email: 'citizen@gmail.com' };
const user = () => ({ id: actor.sub, email: 'citizen@gmail.com', password: 'synthetic-derived-hash', emailVerified: null, role: 'USER', status: 'ACTIVE', department: null,
  isMainAdmin: false, tokens: [{ id: actor.sessionId }], authIdentities: [passwordIdentity] });
const intent = () => ({ id: 'intent', userId: actor.sub, sessionId: actor.sessionId, stateHash: hash(state), passwordFingerprint: hash(user().password),
  email: user().email, pkceChallenge: challenge(verifier), createdAt: new Date(), expiresAt: new Date(Date.now() + 300_000), consumedAt: null as Date | null });
const profile = (overrides = {}) => ({ provider: 'google', id: 'google-sub', emails: [{ value: user().email, verified: true }], _json: { email: user().email, email_verified: true }, ...overrides } as never);
const noMutation = () => { for (const fn of [mocks.upsert, mocks.create, mocks.remove, mocks.deleteIntent, mocks.revoke, mocks.audit]) expect(fn).not.toHaveBeenCalled(); };

beforeEach(() => {
  vi.resetAllMocks(); mocks.lookup.mockResolvedValue(user()); mocks.verify.mockResolvedValue(true); mocks.current.mockResolvedValue(user());
  mocks.intent.mockResolvedValue(intent()); mocks.claim.mockResolvedValue({ count: 1 }); mocks.binding.mockResolvedValue(null); mocks.remove.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation(callback => callback({ $queryRaw: mocks.lock, user: { findUnique: mocks.current },
    authIdentity: { findUnique: mocks.binding, create: mocks.create, deleteMany: mocks.remove },
    googleLinkIntent: { upsert: mocks.upsert, findUnique: mocks.intent, updateMany: mocks.claim, deleteMany: mocks.deleteIntent },
    token: { updateMany: mocks.revoke }, auditLog: { create: mocks.audit } }));
});
describe('password-confirmed Google connection', () => {
  it('returns only safe own-method metadata, no credential or provider subject', async () => {
    mocks.current.mockResolvedValue({ ...user(), authIdentities: [passwordIdentity, googleIdentity] });
    const result = await GetLoginMethodsService(actor);
    expect(result).toMatchObject({ code: 200, data: { accountId: actor.sub, password: true, google: { connected: true, email: user().email }, canUnlinkGoogle: true } });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-derived-hash|google-sub|session/); noMutation();
  });
  it('never offers unlinking the only Google login method', async () => {
    mocks.current.mockResolvedValue({ ...user(), password: null, authIdentities: [googleIdentity] });
    expect(await GetLoginMethodsService(actor)).toMatchObject({ data: { password: false, canUnlinkGoogle: false } }); noMutation();
  });
  it('starts a five-minute intent after password verification and locks both account and session', async () => {
    const result = await BeginGoogleLinkService(actor, 'private-password');
    expect(result.code).toBe(200);
    if (!('data' in result) || !result.data || !('verifier' in result) || !('state' in result)) throw Error('Expected started intent');
    const url = new URL(result.data.authorizationUrl);
    expect(url.origin).toBe('https://accounts.google.com'); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(challenge(result.verifier));
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.test/api/auth/v1/google/callback');
    const stored = mocks.upsert.mock.calls[0][0].create;
    expect(stored).toMatchObject({ userId: actor.sub, sessionId: actor.sessionId, stateHash: hash(result.state), passwordFingerprint: hash(user().password), email: user().email });
    expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(299_000);
    expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect(JSON.stringify(stored)).not.toContain('private-password'); expect(JSON.stringify(stored)).not.toContain(result.verifier);
    expect(mocks.lock).toHaveBeenCalledTimes(2); expect(mocks.verify.mock.invocationCallOrder[0]).toBeLessThan(mocks.upsert.mock.invocationCallOrder[0]);
  });
  it('does not start with an incorrect password', async () => {
    mocks.verify.mockResolvedValue(false); expect((await BeginGoogleLinkService(actor, 'wrong')).code).toBe(403); noMutation();
  });
  it.each([{ password: 'changed' }, { tokens: [] }, { status: 'INACTIVE' }, { role: 'RESPONDER', department: 'FIRE' }])('rechecks proof/session/role after lock: %j', async change => {
    mocks.current.mockResolvedValue({ ...user(), ...change }); expect((await BeginGoogleLinkService(actor, 'password')).code).toBe(409); noMutation();
  });
  it('does not overwrite an existing Google method', async () => {
    mocks.current.mockResolvedValue({ ...user(), authIdentities: [passwordIdentity, googleIdentity] });
    expect((await BeginGoogleLinkService(actor, 'password')).code).toBe(409); noMutation();
  });
  it('supports an active assigned admin only after explicit password confirmation', async () => {
    mocks.current.mockResolvedValue({ ...user(), role: 'ADMIN', department: 'MAIN', isMainAdmin: true, emailVerified: new Date() });
    expect((await BeginGoogleLinkService(actor, 'password')).code).toBe(200); expect(mocks.verify).toHaveBeenCalledOnce();
  });
  it('claims an intent only once and only with its S256 verifier', async () => {
    expect(await ClaimGoogleLinkService(actor, state, verifier)).toMatchObject({ id: 'intent', consumedAt: expect.any(Date) });
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'intent', stateHash: hash(state), consumedAt: null, expiresAt: { gt: expect.any(Date) } } }));
    mocks.intent.mockResolvedValue({ ...intent(), consumedAt: new Date() });
    expect(await ClaimGoogleLinkService(actor, state, verifier)).toBeNull(); expect(mocks.claim).toHaveBeenCalledOnce();
  });
  it.each([{ userId: 'other' }, { sessionId: 'other' }, { email: 'other@gmail.com' }, { passwordFingerprint: 'other' }, { expiresAt: new Date(0) }, { pkceChallenge: 'other' }])('rejects stale/rebound intent %j', async change => {
    mocks.intent.mockResolvedValue({ ...intent(), ...change }); expect(await ClaimGoogleLinkService(actor, state, verifier)).toBeNull(); expect(mocks.claim).not.toHaveBeenCalled(); noMutation();
  });
  it('rejects malformed state/verifier before database calls', async () => {
    expect(await ClaimGoogleLinkService(actor, 'link.bad', verifier)).toBeNull(); expect(await ClaimGoogleLinkService(actor, state, 'bad')).toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled(); noMutation();
  });
  it('rejects claim loss and logout before code exchange', async () => {
    mocks.claim.mockResolvedValue({ count: 0 }); expect(await ClaimGoogleLinkService(actor, state, verifier)).toBeNull();
    mocks.current.mockResolvedValue({ ...user(), tokens: [] }); expect(await ClaimGoogleLinkService(actor, state, verifier)).toBeNull(); noMutation();
  });
  it('links only the claimed account, leaves local verification and RBAC untouched, revokes other sessions', async () => {
    const claimed = { ...intent(), consumedAt: new Date() }; mocks.intent.mockResolvedValue(claimed);
    expect((await CompleteGoogleLinkService(actor, claimed, profile())).code).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith({ data: { userId: actor.sub, provider: 'google', providerUserId: 'google-sub', email: user().email } });
    expect(mocks.revoke).toHaveBeenCalledWith({ where: { userId: actor.sub, type: 'REFRESH', id: { not: actor.sessionId }, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(mocks.audit).toHaveBeenCalledOnce(); expect(mocks.claim).not.toHaveBeenCalled();
  });
  it.each([{ _json: { email: user().email, email_verified: false } }, { emails: [{ value: 'other@gmail.com', verified: true }], _json: { email: 'other@gmail.com', email_verified: true } }])('rejects unverified or different Google email %j', async change => {
    expect((await CompleteGoogleLinkService(actor, { ...intent(), consumedAt: new Date() }, profile(change))).code).toBe(403); noMutation();
  });
  it.each([{ stateHash: 'superseded' }, { consumedAt: null }, { expiresAt: new Date(0) }])('rejects superseded/unclaimed/expired completion %j', async change => {
    const claimed = { ...intent(), consumedAt: new Date() }; mocks.intent.mockResolvedValue({ ...claimed, ...change });
    expect((await CompleteGoogleLinkService(actor, claimed, profile())).code).toBe(409); noMutation();
  });
  it('rejects logout, reset and account-switch during Google exchange', async () => {
    const claimed = { ...intent(), consumedAt: new Date() }; mocks.intent.mockResolvedValue(claimed);
    for (const change of [{ tokens: [] }, { password: 'new hash' }, { id: 'other' }]) {
      mocks.current.mockResolvedValue({ ...user(), ...change }); expect((await CompleteGoogleLinkService(actor, claimed, profile())).code).toBe(409);
    } noMutation();
  });
  it('never transfers a Google identity from another user', async () => {
    const claimed = { ...intent(), consumedAt: new Date() }; mocks.intent.mockResolvedValue(claimed); mocks.binding.mockResolvedValue({ userId: 'other' });
    expect((await CompleteGoogleLinkService(actor, claimed, profile())).code).toBe(409); noMutation();
  });
  it('maps uniqueness races to a safe conflict, never a second account', async () => {
    const claimed = { ...intent(), consumedAt: new Date() }; mocks.intent.mockResolvedValue(claimed); mocks.create.mockRejectedValue({ code: 'P2002' });
    expect((await CompleteGoogleLinkService(actor, claimed, profile())).code).toBe(409); expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it('unlinks only Google, preserves the confirmed password and current session', async () => {
    mocks.current.mockResolvedValue({ ...user(), authIdentities: [passwordIdentity, googleIdentity] });
    expect((await UnlinkGoogleService(actor, 'password')).code).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith({ where: { userId: actor.sub, provider: 'google' } });
    expect(mocks.deleteIntent).toHaveBeenCalledOnce(); expect(mocks.revoke).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: actor.sub, type: 'REFRESH', id: { not: actor.sessionId }, revokedAt: null } }));
  });
  it('cannot unlink the last method even if the browser forges availability', async () => {
    mocks.lookup.mockResolvedValue({ ...user(), password: null }); expect((await UnlinkGoogleService(actor, 'password')).code).toBe(403); noMutation();
  });
  it('requires an actual password identity, not just a cached UI flag', async () => {
    mocks.current.mockResolvedValue({ ...user(), authIdentities: [googleIdentity] }); expect((await UnlinkGoogleService(actor, 'password')).code).toBe(409); noMutation();
  });
  it('never unlinks with a wrong password or after password reset', async () => {
    mocks.verify.mockResolvedValue(false); expect((await UnlinkGoogleService(actor, 'wrong')).code).toBe(403);
    mocks.verify.mockResolvedValue(true); mocks.current.mockResolvedValue({ ...user(), password: 'changed' }); expect((await UnlinkGoogleService(actor, 'password')).code).toBe(409); noMutation();
  });
});
