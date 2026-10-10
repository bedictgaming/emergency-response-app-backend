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
import { BeginGoogleLinkService, ClaimGoogleLinkService, CompleteGoogleLinkService, GetLoginMethodsService, UnlinkGoogleService } from '@/services/auth/google-link-service';
import { GoogleOAuthService } from '@/services/auth/google-oauth-service';
import { ResetPasswordService } from '@/services/auth/password-reset-service';

const run = process.env.RUN_NATIVE_AUTH_IDENTITY_TESTS === '1';
const ids: string[] = [];
const password = 'Synthetic-Password-Only-2026';
let hashed: string;
type Fixture = { actor: JwtPayload; email: string; cookie: string };
function guard() {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.DATABASE_URL !== process.env.DISPOSABLE_DATABASE_URL || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.pathname !== '/alert_disposable' || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'alert_disposable'
    || ENV.NODE_ENV !== 'test' || ENV.BACKGROUND_JOBS_ENABLED || ENV.EVIDENCE_DELETION_ENABLED
    || ENV.ORPHAN_EVIDENCE_SWEEP_ENABLED || ENV.API_GATEWAY_REQUIRED || ENV.WEB_PUSH_PRIVATE_KEY
    || ENV.CLOUDINARY.API_SECRET || ENV.SMTP.PASS || process.env.BREVO_API_KEY) throw Error('NATIVE_SYNTHETIC_IDENTITY_TARGET_REQUIRED');
}
async function fixture(noPassword = false, verified = false, operational = false): Promise<Fixture> {
  const id = randomUUID(), sessionId = randomUUID(); ids.push(id);
  const email = `synthetic-${id}@gmail.com`;
  await prisma.user.create({ data: { id, email, name: 'Synthetic identity gate', password: noPassword ? null : hashed,
    emailVerified: verified ? new Date() : null, role: operational ? 'ADMIN' : 'USER', department: operational ? 'FIRE' : null,
    authIdentities: noPassword ? undefined : { create: { provider: 'password', providerUserId: id, email } } } });
  await prisma.token.create({ data: { id: sessionId, userId: id, type: 'REFRESH', token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
  return { actor: { sub: id, role: operational ? 'ADMIN' : 'USER', type: 'access', sessionId }, email,
    cookie: `accessToken=${signAccessToken(id, operational ? 'ADMIN' : 'USER', '15m', sessionId)}` };
}
const profile = (email: string, sub = randomUUID(), verified = true): Profile => ({ provider: 'google', id: sub,
  displayName: 'Synthetic identity gate', emails: [{ value: email, verified }], _raw: '', _json: { email, email_verified: verified } } as Profile);
const bindings = (f: Fixture) => prisma.authIdentity.count({ where: { userId: f.actor.sub, provider: 'google' } });
const activeSessions = (f: Fixture) => prisma.token.count({ where: { userId: f.actor.sub, type: 'REFRESH', revokedAt: null, consumedAt: null } });
async function pending(f: Fixture) {
  const started = await BeginGoogleLinkService(f.actor, password);
  if (!('state' in started) || !('verifier' in started)) throw Error('SYNTHETIC_INTENT_START_FAILED');
  const claim = await ClaimGoogleLinkService(f.actor, started.state, started.verifier);
  if (!claim) throw Error('SYNTHETIC_INTENT_CLAIM_FAILED');
  return { started, claim };
}
async function connected(f: Fixture) {
  const p = await pending(f), who = profile(f.email);
  expect((await CompleteGoogleLinkService(f.actor, p.claim, who)).code).toBe(200);
  return who;
}
async function whileUserLocked(f: Fixture, operation: () => Promise<unknown>, mutate: (client: pg.Client) => Promise<unknown>) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  let outcome: Promise<unknown> | undefined;
  try {
    await client.query('BEGIN'); await client.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [f.actor.sub]);
    outcome = operation();
    const deadline = Date.now() + 5000; let blocked = false;
    while (Date.now() < deadline) {
      const result = await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'");
      if (result.rows[0].n > 0) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true); await mutate(client); await client.query('COMMIT'); return await outcome;
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); if (outcome) await outcome; }
}

describe.runIf(run)('native identity registry transactions and races, synthetic only', () => {
  beforeAll(async () => {
    guard(); hashed = await hashPassword(password);
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('PROVIDER_NETWORK_FORBIDDEN'); }));
  });
  afterAll(async () => {
    if (!run) return;
    try {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS synthetic_identity_audit_failure ON audit_logs');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS synthetic_identity_audit_failure()');
      await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } }); expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); await prisma.$disconnect(); }
  });
  it('creates one Google citizen and repeatedly signs in to the same user with bound sessions', async () => {
    const who = profile(`synthetic-${randomUUID()}@gmail.com`);
    const first = await GoogleOAuthService(who); expect(first.code).toBe(200);
    if (!first.data) throw Error('SYNTHETIC_LOGIN_FAILED'); ids.push(first.data.user.id);
    const again = await GoogleOAuthService(who); expect(again.data?.user.id).toBe(first.data.user.id);
    expect(await prisma.user.count({ where: { email: who.emails![0]!.value } })).toBe(1);
    expect(await prisma.authIdentity.count({ where: { userId: first.data.user.id } })).toBe(1);
    expect((await request(app).get('/api/auth/v1/me').set('Cookie', `accessToken=${again.data!.tokens.accessToken}`)).status).toBe(200);
  });
  it('auto-links only a locally verified citizen, never a second user', async () => {
    const f = await fixture(false, true), who = profile(f.email);
    expect((await GoogleOAuthService(who)).data?.user.id).toBe(f.actor.sub);
    expect((await GoogleOAuthService(who)).data?.user.id).toBe(f.actor.sub);
    expect(await bindings(f)).toBe(1); expect(await prisma.user.count({ where: { email: f.email } })).toBe(1);
    expect((await request(app).get('/api/auth/v1/me').set('Cookie', f.cookie)).status).toBe(401);
  });
  it('rejects unverified Google email and requires step-up for unverified locals and admins', async () => {
    for (const f of [await fixture(false, true), await fixture(), await fixture(false, true, true)]) {
      expect((await GoogleOAuthService(profile(f.email, randomUUID(), false))).code).toBe(409);
      if (!f.actor.role || f.actor.role === 'ADMIN' || !(await prisma.user.findUniqueOrThrow({ where: { id: f.actor.sub } })).emailVerified)
        expect((await GoogleOAuthService(profile(f.email))).code).toBe(409);
      expect(await bindings(f)).toBe(0);
    }
  });
  it('rejects normalized duplicate email and rolls back atomic nested Google creation', async () => {
    const f = await fixture();
    await expect(prisma.user.create({ data: { email: ` ${f.email.toUpperCase()} ` } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.authIdentity.create({ data: { provider: 'google', providerUserId: randomUUID(), user: { create: { email: f.email } } } })).rejects.toMatchObject({ code: 'P2002' });
    expect(await bindings(f)).toBe(0); expect(await prisma.user.count({ where: { email: f.email } })).toBe(1);
  });
  it('password-confirmed connection preserves account state and only the current session', async () => {
    const f = await fixture(), before = await prisma.user.findUniqueOrThrow({ where: { id: f.actor.sub } });
    await prisma.token.create({ data: { userId: f.actor.sub, type: 'REFRESH', token: randomUUID(), expiresAt: new Date(Date.now() + 60000) } });
    const who = await connected(f);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: f.actor.sub } })).toEqual(before);
    expect(await activeSessions(f)).toBe(1); expect((await GetLoginMethodsService(f.actor)).code).toBe(200);
    expect((await GoogleOAuthService({ ...who, emails: [{ value: 'changed@example.test', verified: false }], _json: {} } as Profile)).data?.user.id).toBe(f.actor.sub);
  });
  it('concurrent callbacks claim exactly once', async () => {
    const f = await fixture(), started = await BeginGoogleLinkService(f.actor, password);
    if (!('state' in started) || !('verifier' in started)) throw Error('SYNTHETIC_INTENT_START_FAILED');
    const results = await Promise.all([ClaimGoogleLinkService(f.actor, started.state, started.verifier), ClaimGoogleLinkService(f.actor, started.state, started.verifier)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it('competing provider bindings commit exactly one identity and audit', async () => {
    const a = await fixture(), b = await fixture(), pa = await pending(a), pb = await pending(b), sub = randomUUID();
    const results = await Promise.all([CompleteGoogleLinkService(a.actor, pa.claim, profile(a.email, sub)), CompleteGoogleLinkService(b.actor, pb.claim, profile(b.email, sub))]);
    expect(results.map(r => r.code).sort()).toEqual([200, 409]);
    expect(await prisma.authIdentity.count({ where: { provider: 'google', providerUserId: sub } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'AUTH_GOOGLE_LINKED', actorId: { in: [a.actor.sub, b.actor.sub] } } })).toBe(1);
  });
  it('audit failure atomically rolls back identity and other-session revocation', async () => {
    const f = await fixture(), p = await pending(f);
    await prisma.token.create({ data: { userId: f.actor.sub, type: 'REFRESH', token: randomUUID(), expiresAt: new Date(Date.now() + 60000) } });
    await prisma.$executeRawUnsafe("CREATE FUNCTION synthetic_identity_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AUTH_GOOGLE_LINKED' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END IF; RETURN NEW; END $$");
    await prisma.$executeRawUnsafe('CREATE TRIGGER synthetic_identity_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION synthetic_identity_audit_failure()');
    try { expect((await CompleteGoogleLinkService(f.actor, p.claim, profile(f.email))).code).toBe(503); expect(await bindings(f)).toBe(0); expect(await activeSessions(f)).toBe(2); }
    finally { await prisma.$executeRawUnsafe('DROP TRIGGER synthetic_identity_audit_failure ON audit_logs'); await prisma.$executeRawUnsafe('DROP FUNCTION synthetic_identity_audit_failure()'); }
  });
  it.each(['password', 'email', 'role', 'session'])('rechecks %s after an observed native lock wait', async change => {
    const f = await fixture(), p = await pending(f);
    const result = await whileUserLocked(f, () => CompleteGoogleLinkService(f.actor, p.claim, profile(f.email)), async client => {
      if (change === 'password') await client.query('UPDATE "User" SET password=$1 WHERE id=$2', ['synthetic-changed-hash', f.actor.sub]);
      if (change === 'email') await client.query('UPDATE "User" SET email=$1 WHERE id=$2', [`changed-${f.actor.sub}@gmail.com`, f.actor.sub]);
      if (change === 'role') await client.query('UPDATE "User" SET role=$1 WHERE id=$2', ['RESPONDER', f.actor.sub]);
      if (change === 'session') await client.query('UPDATE "Token" SET "revokedAt"=now() WHERE id=$1', [f.actor.sessionId]);
    });
    expect(result).toMatchObject({ code: 409 }); expect(await bindings(f)).toBe(0);
  });
  it('password reset invalidates the pending link and keeps a password identity', async () => {
    const f = await fixture(), p = await pending(f), reset = randomUUID();
    await prisma.token.create({ data: { userId: f.actor.sub, type: 'PASSWORD_RESET', token: createHash('sha256').update(reset).digest('hex'), expiresAt: new Date(Date.now() + 60000) } });
    expect((await ResetPasswordService(reset, 'Synthetic-New-Password-2026')).code).toBe(200);
    expect((await CompleteGoogleLinkService(f.actor, p.claim, profile(f.email))).code).toBe(409);
    expect(await activeSessions(f)).toBe(0); expect(await prisma.authIdentity.count({ where: { userId: f.actor.sub, provider: 'password' } })).toBe(1);
  });
  it('Google-only accounts cannot remove their last method', async () => {
    const f = await fixture(true); await prisma.authIdentity.create({ data: { userId: f.actor.sub, provider: 'google', providerUserId: randomUUID(), email: f.email } });
    expect((await UnlinkGoogleService(f.actor, password)).code).toBe(403); expect(await bindings(f)).toBe(1);
  });
  it('unlink and stable Google login serialize without leaving a late Google session', async () => {
    for (let i = 0; i < 4; i++) {
      const f = await fixture(), who = await connected(f);
      const result = await Promise.all([GoogleOAuthService(who), UnlinkGoogleService(f.actor, password)]);
      expect(result[1].code).toBe(200); expect([200, 403, 409]).toContain(result[0].code);
      expect(await bindings(f)).toBe(0); expect(await activeSessions(f)).toBe(1);
      expect((await request(app).get('/api/auth/v1/me').set('Cookie', f.cookie)).status).toBe(200);
      if (result[0].data) expect((await request(app).get('/api/auth/v1/me').set('Cookie', `accessToken=${result[0].data.tokens.accessToken}`)).status).toBe(401);
    }
  }, 30000);
});
