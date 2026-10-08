import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import type { Profile } from 'passport-google-oauth20';
import app from '@/app';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { hashPassword } from '@/utils/password';
import { signAccessToken } from '@/lib/jwt';
import type { JwtPayload } from '@/lib/jwt';
import { beginGoogleLink, claimGoogleLink, completeGoogleLink, googleLinkStatus, unlinkGoogle } from '@/services/auth/google-link-service';
import { GoogleOAuthService } from '@/services/auth/google-oauth-service';
import { ResetPasswordService } from '@/services/auth/password-reset-service';

const run = process.env.RUN_NATIVE_GOOGLE_LINK_TESTS === '1';
const ids: string[] = [];
const password = 'Synthetic-Password-Only-2026';
let hashed: string;
type Fixture = { actor: JwtPayload; email: string; refresh: string; cookie: string };
function guard() {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.DATABASE_URL !== process.env.DISPOSABLE_DATABASE_URL || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.pathname !== '/alert_disposable' || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
    || ENV.NODE_ENV !== 'test' || !ENV.GOOGLE_ACCOUNT_LINKING_ENABLED || ENV.BACKGROUND_JOBS_ENABLED
    || ENV.EVIDENCE_DELETION_ENABLED || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED || ENV.API_GATEWAY_REQUIRED
    || ENV.WEB_PUSH_PRIVATE_KEY || ENV.CLOUDINARY.API_SECRET || ENV.SMTP.PASS || process.env.BREVO_API_KEY)
    throw new Error('NATIVE_SYNTHETIC_GOOGLE_TARGET_REQUIRED');
}
async function fixture(noPassword = false): Promise<Fixture> {
  const id = randomUUID(), sessionId = randomUUID(), refresh = randomUUID(); ids.push(id);
  const email = `synthetic-${id}@gmail.com`;
  await prisma.user.create({ data: { id, email, name: 'Synthetic Google gate', password: noPassword ? null : hashed, role: 'USER' } });
  await prisma.token.create({ data: { id: sessionId, userId: id, type: 'REFRESH', token: refresh, expiresAt: new Date(Date.now() + 3600000) } });
  const actor: JwtPayload = { sub: id, role: 'USER', type: 'access', sessionId };
  return { actor, email, refresh, cookie: `accessToken=${signAccessToken(id, 'USER', '15m', sessionId)}; refreshToken=${refresh}` };
}
async function pending(f: Fixture) {
  const started = await beginGoogleLink(f.actor, password);
  return { started, claim: await claimGoogleLink(f.actor, started.state, started.verifier) };
}
const identity = (f: Fixture, sub = randomUUID()) => ({ sub, email: f.email });
const profile = (sub: string): Profile => ({ provider: 'google', id: sub, displayName: 'Synthetic Google gate', _raw: '', _json: {} } as Profile);
const activeSessions = (f: Fixture) => prisma.token.count({ where: { userId: f.actor.sub, type: 'REFRESH', revokedAt: null, consumedAt: null } });
const bindings = (f: Fixture) => prisma.oAuthAccount.count({ where: { userId: f.actor.sub, provider: 'google' } });
async function connected(f: Fixture) {
  const p = await pending(f), who = identity(f); await completeGoogleLink(f.actor, p.claim, who); return who;
}

// Hold a native User lock in a separate connection, wait until the service's
// competing transaction actually blocks, then mutate and commit. This is not a
// timing-only sleep or embedded serial SQL emulation.
async function whileUserLocked(f: Fixture, operation: () => Promise<unknown>, mutate: (client: pg.Client) => Promise<unknown>) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  let task: Promise<unknown> | undefined, outcome: Promise<PromiseSettledResult<unknown>> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [f.actor.sub]);
    task = operation(); outcome = task.then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      const r = await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'");
      if (r.rows[0].n > 0) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await mutate(client); await client.query('COMMIT');
    return await outcome;
  } finally {
    await client.query('ROLLBACK').catch(() => {}); await client.end();
    if (outcome) await outcome;
  }
}

describe.runIf(run)('native PostgreSQL explicit Google-link transactions and races (no provider calls)', () => {
  beforeAll(async () => {
    guard();
    const probe = new pg.Client({ connectionString: process.env.DATABASE_URL }); await probe.connect();
    try { expect((await probe.query('SELECT version() AS v')).rows[0].v).toMatch(/^PostgreSQL /); } finally { await probe.end(); }
    hashed = await hashPassword(password);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('PROVIDER_NETWORK_FORBIDDEN'); }));
  });
  afterAll(async () => {
    if (!run) return;
    try {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS synthetic_link_audit_failure ON audit_logs');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS synthetic_link_audit_failure()');
      await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); await prisma.$disconnect(); }
  });
  it('links without changing ownership, role, verification, or issuing a session, and accepts ordinary stable-ID login', async () => {
    const f = await fixture(), before = await prisma.user.findUniqueOrThrow({ where: { id: f.actor.sub } });
    const who = await connected(f);
    expect(await googleLinkStatus(f.actor)).toEqual({ available: true, linked: true, hasPassword: true });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: f.actor.sub } })).toEqual(before);
    expect(await activeSessions(f)).toBe(1);
    expect(await prisma.googleLinkIntent.count({ where: { userId: f.actor.sub } })).toBe(0);
    expect((await GoogleOAuthService(profile(who.sub))).code).toBe(200);
    expect(await activeSessions(f)).toBe(2);
  });
  it('concurrent same-state callbacks claim once and a replaced attempt cannot claim', async () => {
    const f = await fixture(), old = await beginGoogleLink(f.actor, password), started = await beginGoogleLink(f.actor, password);
    await expect(claimGoogleLink(f.actor, old.state, old.verifier)).rejects.toMatchObject({ reason: 'expired' });
    const results = await Promise.allSettled([claimGoogleLink(f.actor, started.state, started.verifier), claimGoogleLink(f.actor, started.state, started.verifier)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it('concurrent provider uniqueness conflicts commit exactly one binding and one audit', async () => {
    const a = await fixture(), b = await fixture(), pa = await pending(a), pb = await pending(b), sub = randomUUID();
    const result = await Promise.allSettled([completeGoogleLink(a.actor, pa.claim, identity(a, sub)), completeGoogleLink(b.actor, pb.claim, identity(b, sub))]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.find(r => r.status === 'rejected')).toMatchObject({ reason: { reason: 'conflict', code: 409 } });
    expect(await prisma.oAuthAccount.count({ where: { provider: 'google', providerAccountId: sub } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'GOOGLE_ACCOUNT_LINKED', actorId: { in: [a.actor.sub, b.actor.sub] } } })).toBe(1);
  });
  it('mismatched email cannot bind or merge and Google-only unlink cannot remove its fallback', async () => {
    const f = await fixture(), p = await pending(f);
    await expect(completeGoogleLink(f.actor, p.claim, { ...identity(f), email: 'other-synthetic@gmail.com' })).rejects.toMatchObject({ reason: 'email_mismatch' });
    expect(await bindings(f)).toBe(0);
    const g = await fixture(true);
    await prisma.oAuthAccount.create({ data: { userId: g.actor.sub, provider: 'google', providerAccountId: randomUUID() } });
    await expect(unlinkGoogle(g.actor, password)).rejects.toMatchObject({ reason: 'password_required' });
    expect(await bindings(g)).toBe(1); expect(await activeSessions(g)).toBe(1);
  });
  it('audit insertion failure rolls back the binding and intent deletion', async () => {
    const f = await fixture(), p = await pending(f);
    // Synthetic-only trigger, installed only in the empty disposable gate.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION synthetic_link_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='GOOGLE_ACCOUNT_LINKED' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER synthetic_link_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION synthetic_link_audit_failure()');
    try {
      await expect(completeGoogleLink(f.actor, p.claim, identity(f))).rejects.toBeDefined();
      expect(await bindings(f)).toBe(0);
      expect(await prisma.googleLinkIntent.findUnique({ where: { id: p.claim.id } })).not.toBeNull();
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER synthetic_link_audit_failure ON audit_logs');
      await prisma.$executeRawUnsafe('DROP FUNCTION synthetic_link_audit_failure()');
    }
  });
  it('completion queued behind logout rejects the revoked session', async () => {
    const f = await fixture(), p = await pending(f);
    const r = await whileUserLocked(f, () => completeGoogleLink(f.actor, p.claim, identity(f)), async () => {
      expect((await request(app).post('/api/auth/v1/logout').set('Origin', ENV.FRONTEND_URL).set('Cookie', f.cookie).send({})).status).toBe(200);
    });
    expect(r).toMatchObject({ status: 'rejected', reason: { reason: 'expired' } }); expect(await bindings(f)).toBe(0);
  });
  it.each(['password', 'email', 'role', 'session'])('completion rechecks %s after a native row-lock wait', async change => {
    const f = await fixture(), p = await pending(f);
    const result = await whileUserLocked(f, () => completeGoogleLink(f.actor, p.claim, identity(f)), async client => {
      if (change === 'password') await client.query('UPDATE "User" SET password=$1 WHERE id=$2', ['synthetic-replaced-hash', f.actor.sub]);
      if (change === 'email') await client.query('UPDATE "User" SET email=$1 WHERE id=$2', [`changed-${f.actor.sub}@gmail.com`, f.actor.sub]);
      if (change === 'role') await client.query('UPDATE "User" SET role=$1 WHERE id=$2', ['RESPONDER', f.actor.sub]);
      if (change === 'session') await client.query('UPDATE "Token" SET "consumedAt"=now() WHERE id=$1', [f.actor.sessionId]);
    });
    expect(result.status).toBe('rejected'); expect(await bindings(f)).toBe(0);
  });
  it('password reset and completion serialize, revoke old sessions, and cannot consume a pending link afterward', async () => {
    const f = await fixture(), p = await pending(f), token = randomUUID();
    await prisma.token.create({ data: { userId: f.actor.sub, type: 'PASSWORD_RESET', token: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60000) } });
    const results = await Promise.allSettled([ResetPasswordService(token, 'Synthetic-New-Password-2026'), completeGoogleLink(f.actor, p.claim, identity(f))]);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { code: 200 } });
    expect(await activeSessions(f)).toBe(0);
    await expect(claimGoogleLink(f.actor, p.started.state, p.started.verifier)).rejects.toMatchObject({ reason: 'expired' });
    expect(await bindings(f)).toBe(results[1].status === 'fulfilled' ? 1 : 0);
    expect((await request(app).get('/api/auth/v1/me').set('Cookie', f.cookie)).status).toBe(401);
  });
  it('concurrent unlink and Google login cannot leave any usable old or late Google session', async () => {
    for (let i = 0; i < 6; i++) {
      const f = await fixture(), who = await connected(f);
      const result = await Promise.all([GoogleOAuthService(profile(who.sub)), unlinkGoogle(f.actor, password)]);
      expect([200, 403, 409]).toContain(result[0].code);
      expect(await bindings(f)).toBe(0); expect(await activeSessions(f)).toBe(0);
      expect((await request(app).get('/api/auth/v1/me').set('Cookie', f.cookie)).status).toBe(401);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: f.actor.sub } }); expect(user.password).toBe(hashed);
    }
  }, 30000);
  it('competing completion/unlink leaves no binding and revokes every prior session', async () => {
    const f = await fixture(), p = await pending(f);
    await prisma.token.create({ data: { userId: f.actor.sub, type: 'REFRESH', token: randomUUID(), expiresAt: new Date(Date.now() + 60000) } });
    const result = await Promise.allSettled([completeGoogleLink(f.actor, p.claim, identity(f)), unlinkGoogle(f.actor, password)]);
    expect(result[1].status).toBe('fulfilled'); expect(await bindings(f)).toBe(0); expect(await activeSessions(f)).toBe(0);
    expect(await prisma.googleLinkIntent.count({ where: { userId: f.actor.sub } })).toBe(0);
  });
});
