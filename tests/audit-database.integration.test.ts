/** Opt-in synthetic PostgreSQL acceptance. Never sends mail/push or creates incidents. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createECDH, randomUUID } from 'node:crypto';
import app from '@/app';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import { OAuthAccountRepository } from '@/repositories/oauth-account.repository';
import { TokenRepository } from '@/repositories/token.repository';
import { hashPassword } from '@/utils/password';

const run = process.env.RUN_AUDIT_DATABASE_TESTS === '1';
const testId = randomUUID();
const emails = ['a', 'b', 'quota', 'owner', 'resend', 'password'].map(label => `audit-${testId}-${label}@example.invalid`);
const password = `Synthetic-${randomUUID()}!`;
const curve = createECDH('prime256v1'); curve.generateKeys();
const subscription = (label: string) => JSON.stringify({ endpoint: `https://fcm.googleapis.com/fcm/send/audit-${testId}-${label}`, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 9).toString('base64url') } });
let quotaId = '', ownerId = '', resendId = '', cookie = '';
let confirmedTarget = false;
describe.runIf(run)('audit PostgreSQL acceptance', () => {
  beforeAll(async () => {
    const target = process.env.DISPOSABLE_DATABASE_URL;
    const name = target && new URL(target).pathname.slice(1);
    if (!target || process.env.DATABASE_URL !== target || process.env.CONFIRM_DISPOSABLE_DATABASE !== name
      || !/^emergency_staging_\d{8}_[a-f0-9]{6}$/.test(name!) || ENV.BACKGROUND_JOBS_ENABLED || ENV.API_GATEWAY_REQUIRED) throw new Error('Explicit synthetic database and disabled workers required');
    const current = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database()::text AS name`;
    expect(current[0].name).toBe(name);
    confirmedTarget = true;
    const hash = await hashPassword(password);
    for (const index of [2, 3, 4, 5]) {
      const user = await prisma.user.create({ data: { email: emails[index], password: hash, name: 'Synthetic audit acceptance', emailVerified: index === 4 ? null : new Date() } });
      if (index === 2) quotaId = user.id;
      if (index === 3) ownerId = user.id;
      if (index === 4) resendId = user.id;
    }
    const login = await request(app).post('/api/auth/v1/login').set('Origin', ENV.FRONTEND_URL).send({ email: emails[2], password });
    expect(login.status).toBe(200);
    cookie = (login.headers['set-cookie'] as unknown as string[]).map(value => value.split(';')[0]).join('; ');
  }, 60000);
  afterAll(async () => {
    if (confirmedTarget) {
      // Only this run's exact synthetic emails; dependent auth/device rows cascade.
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
      expect(await prisma.user.count({ where: { email: { in: emails } } })).toBe(0);
      await prisma.$disconnect();
    }
  }, 30000);
  it('rolls back the losing nested user when provider creation races', async () => {
    const repo = new OAuthAccountRepository();
    const results = await Promise.allSettled([0, 1].map(index => repo.createUserWithAccount({ providerAccountId: `audit-${testId}`, name: 'Synthetic audit', email: emails[index] })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await prisma.user.count({ where: { email: { in: emails.slice(0, 2) } } })).toBe(1);
    expect(await prisma.oAuthAccount.count({ where: { provider: 'google', providerAccountId: `audit-${testId}` } })).toBe(1);
  }, 30000);
  it('cannot link an existing password user through an email collision', async () => {
    await expect(new OAuthAccountRepository().createUserWithAccount({ providerAccountId: `collision-${testId}`, name: 'Synthetic audit', email: emails[5] })).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.oAuthAccount.count({ where: { providerAccountId: `collision-${testId}` } })).toBe(0);
  }, 30000);
  it('serializes concurrent device registration and blocks transfer into a full account', async () => {
    await prisma.deviceToken.createMany({ data: Array.from({ length: 9 }, (_, index) => ({ userId: quotaId, token: subscription(`seed-${index}`), platform: 'web' })) });
    const post = (token: string) => request(app).post('/api/notifications/v1/device-token').set('Origin', ENV.FRONTEND_URL).set('Cookie', cookie).send({ token, platform: 'web' });
    const responses = await Promise.all([post(subscription('race-a')), post(subscription('race-b'))]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 429]);
    expect(await prisma.deviceToken.count({ where: { userId: quotaId } })).toBe(10);
    const owned = subscription('transfer');
    await prisma.deviceToken.create({ data: { userId: ownerId, token: owned, platform: 'web' } });
    expect((await post(owned)).status).toBe(429);
    expect((await prisma.deviceToken.findUnique({ where: { token: owned } }))?.userId).toBe(ownerId);
  }, 60000);
  it('serializes resend claims while preserving the original valid verification link', async () => {
    const token = await prisma.token.create({ data: { userId: resendId, type: 'EMAIL_VERIFY', token: randomUUID(), createdAt: new Date(Date.now() - 120000), expiresAt: new Date(Date.now() + 3600000) } });
    const repo = new TokenRepository();
    const claims = await Promise.all([repo.claimVerificationResend(resendId), repo.claimVerificationResend(resendId)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.token.id).toBe(token.id);
    expect((await prisma.token.findUnique({ where: { id: token.id } }))?.revokedAt).toBeNull();
    expect(await prisma.token.count({ where: { userId: resendId, type: 'EMAIL_VERIFY' } })).toBe(2);
  }, 30000);
});
