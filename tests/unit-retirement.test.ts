import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), incident: vi.fn(), verify: vi.fn(), write: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: mocks.user }, incident: { findFirst: mocks.incident }, $transaction: mocks.write } }));
vi.mock('@/lib/jwt', async original => ({ ...await original<typeof import('@/lib/jwt')>(), verifyAccessToken: mocks.verify }));
import app from '@/app';
import { permissionsForActor, Permission } from '@/domain/permissions.policy';
const userId = '11111111-1111-4111-8111-111111111111', sessionId = '22222222-2222-4222-8222-222222222222';
const calls: Array<[string, string]> = [
  ['get', '/units/v1/'], ['post', '/units/v1/'], ['put', `/units/v1/${userId}`], ['delete', `/units/v1/${userId}`], ['get', `/units/v1/${userId}/resources`],
  ['get', '/resources/v1/'], ['post', '/resources/v1/'], ['put', `/resources/v1/${userId}`], ['delete', `/resources/v1/${userId}`],
  ['get', '/incident-units/v1/'], ['put', `/incident-units/v1/${userId}`], ['delete', `/incident-units/v1/${userId}`],
  ['get', `/incidents/v1/${userId}/units`], ['post', `/incidents/v1/${userId}/units`], ['delete', `/incidents/v1/${userId}/units/${sessionId}`],
];
const call = (method: string, path: string, authenticated = true, prefix = '/api') => {
  const client = request(app) as unknown as Record<string, (url: string) => request.Test>;
  const result = client[method](prefix + path);
  return authenticated ? result.set('Authorization', 'Bearer synthetic-unit-retirement-token') : result;
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockReturnValue({ sub: userId, sessionId, role: 'ADMIN', type: 'access' });
  mocks.user.mockResolvedValue({ id: userId, role: 'ADMIN', department: 'FIRE', isMainAdmin: false, status: 'ACTIVE', tokens: [{ id: sessionId }] });
  mocks.incident.mockResolvedValue({ incidentId: userId });
});
describe('physical dispatch retirement HTTP boundary', () => {
  it.each(calls)('%s %s stays authenticated and returns 410 without mutations', async (method, path) => {
    expect((await call(method, path, false)).status).toBe(401);
    const result = await call(method, path);
    expect(result.status).toBe(410); expect(result.body.message).toContain('outside this app');
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.headers['set-cookie']).toBeUndefined(); expect(result.headers.location).toBeUndefined();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each(['USER', 'RESPONDER'])('does not grant %s access to retired operational endpoints', async role => {
    mocks.user.mockResolvedValue({ id: userId, role, department: null, isMainAdmin: false, status: 'ACTIVE', tokens: [{ id: sessionId }] });
    for (const [method, path] of calls) expect((await call(method, path)).status).toBe(403);
    expect(mocks.incident).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('keeps incident scope and revoked-session checks before the retirement response', async () => {
    mocks.incident.mockResolvedValue(null);
    expect((await call('post', `/incidents/v1/${userId}/units`)).status).toBe(403);
    mocks.user.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE', department: 'FIRE', isMainAdmin: false, tokens: [] });
    expect((await call('post', '/units/v1/')).status).toBe(401);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each(['/api', '/API', '/aPi'])('retirement applies to router prefix %s', async prefix => {
    expect((await call('post', '/units/v1/', true, prefix)).status).toBe(410);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each([{ role: 'ADMIN', department: 'MAIN', isMainAdmin: true }, { role: 'ADMIN', department: 'FIRE' }, { role: 'DISPATCHER', department: 'MEDICAL' }])('no current staff actor is granted dispatch management: %j', actor => {
    expect(permissionsForActor(actor)).not.toContain(Permission.DispatchManageDepartment);
  });
});
