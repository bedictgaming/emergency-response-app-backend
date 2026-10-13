import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@/lib/jwt';
import { operationalAccount } from './helpers/operational-account';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), publish: vi.fn(), cleanup: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/events', () => ({ publishEmergencyEvent: mocks.publish }));
vi.mock('@/lib/jobs', () => ({ enqueueAssetCleanup: mocks.cleanup, enqueueNotification: vi.fn() }));
import { IncidentRepository } from '@/repositories/incident.repository';
import { FlagIncidentService, ReviewIncidentFlagService, CorrectIncidentFlagService } from '@/services/incident/review-incident-service';
import { DeleteIncidentService } from '@/services/incident/delete-incident-service';
import { UpdateServiceResponseService } from '@/services/incident/update-service-response-service';
import { lockOperationalActor } from '@/lib/operational-actor';
import { correctIncidentFlagSchema } from '@/validation/incident/review-incident.schema';

const main: JwtPayload = { sub: 'main', sessionId: 'session', role: 'ADMIN', type: 'access', department: 'MAIN', isMainAdmin: true };
const fire: JwtPayload = { ...main, sub: 'fire', department: 'FIRE', isMainAdmin: false };
const version = '2026-10-12T00:00:00.000Z';
const input = { status: 'CONFIRMED' as const, reviewNotes: 'Verified with an on-site investigation.', expectedUpdatedAt: version };
const closed = { incidentId: 'incident', status: 'CLOSED', attachments: [], incidentUnits: [], tasks: [], reviewFlags: [] };

describe('transactional administrator authority', () => {
  beforeEach(() => {
    vi.restoreAllMocks(); vi.clearAllMocks();
    vi.spyOn(IncidentRepository.prototype, 'findById').mockResolvedValue(closed as never);
  });

  const actions = [
    { name: 'flagging', actor: fire, run: () => FlagIncidentService('incident', 'On-site investigation requested.', fire) },
    { name: 'reviewing', actor: main, run: () => ReviewIncidentFlagService('incident', 'flag', input, main) },
    { name: 'correcting', actor: main, run: () => CorrectIncidentFlagService('incident', 'flag', input, main) },
    { name: 'deleting', actor: main, run: () => DeleteIncidentService('incident', main, { reason: 'Closed synthetic review record.', confirmation: 'DELETE' }) },
    { name: 'completing a response', actor: fire, run: () => UpdateServiceResponseService('incident', 'FIRE', 'RESOLVED', fire) },
  ];
  for (const action of actions) {
    it.each(['inactive', 'demoted', 'transferred', 'session-revoked'])(`rejects ${action.name} after %s commits ahead of the actor lock`, async change => {
      const current = operationalAccount(action.actor);
      const user = { findUnique: vi.fn(async () => current) };
      const write = vi.fn();
      const tx = { $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        // Model a permission withdrawal committed while this request waited
        // for User. Native two-connection coverage is a separate test gate.
        if (strings.join('').includes('"User"')) {
          if (change === 'inactive') current.status = 'INACTIVE';
          if (change === 'demoted') current.role = 'USER';
          if (change === 'transferred') current.department = 'MEDICAL';
          if (change === 'session-revoked') current.tokens = [];
        }
        return [];
      }), user,
      incident: { findFirst: write, findUnique: write, delete: write, update: write },
      incidentReviewFlag: { findUnique: write, create: write, update: write },
      incidentServiceResponse: { update: write }, auditLog: { create: write } };
      mocks.transaction.mockImplementation(callback => callback(tx));
      expect((await action.run()).code).toBe(403);
      expect(write).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.cleanup).not.toHaveBeenCalled();
      expect(tx.$queryRaw.mock.calls.some(([strings]) => strings.join('').includes('incidents'))).toBe(false);
    });
  }

  it('locks User then Token and rereads an active matching account/session', async () => {
    const tx = { $queryRaw: vi.fn(), user: { findUnique: vi.fn().mockResolvedValue(operationalAccount(fire)) } };
    expect(await lockOperationalActor(tx as never, fire)).toMatchObject({ role: 'ADMIN', department: 'FIRE' });
    expect(tx.$queryRaw.mock.calls.map(([strings]) => strings.join(''))).toEqual([
      expect.stringContaining('FROM "User"'), expect.stringContaining('FROM "Token"'),
    ]);
    expect(tx.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ tokens: expect.objectContaining({ where: expect.objectContaining({ id: 'session', consumedAt: null, revokedAt: null, type: 'REFRESH', expiresAt: expect.anything() }) }) }) }));
  });

  it.each([undefined, 'expired'])('fails closed with a missing or expired access session: %s', async session => {
    const tx = { $queryRaw: vi.fn(), user: { findUnique: vi.fn().mockResolvedValue(operationalAccount(fire)) } };
    await expect(lockOperationalActor(tx as never, { ...fire, ...(session ? { exp: 1 } : { sessionId: undefined }) })).rejects.toMatchObject({ code: 403 });
  });

  it('validates corrections server-side and rejects attempted status overrides', () => {
    const params = { id: '10000000-0000-4000-8000-000000000001', flagId: '20000000-0000-4000-8000-000000000002' };
    const body = { reviewNotes: 'A genuine emergency was confirmed.', expectedUpdatedAt: version };
    expect(correctIncidentFlagSchema.safeParse({ params, body }).success).toBe(true);
    for (const invalid of [{ ...body, reviewNotes: 'short' }, { ...body, expectedUpdatedAt: 'invalid' }, { ...body, status: 'CONFIRMED' }]) {
      expect(correctIncidentFlagSchema.safeParse({ params, body: invalid }).success).toBe(false);
    }
  });
});
