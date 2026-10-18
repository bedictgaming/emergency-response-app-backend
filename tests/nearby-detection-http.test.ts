import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
const mocks = vi.hoisted(() => ({ account: vi.fn(), token: vi.fn(), transaction: vi.fn(), first: vi.fn(), many: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: mocks.account }, $transaction: mocks.transaction } }));
vi.mock('@/lib/jwt', async original => ({ ...await original<object>(), verifyAccessToken: mocks.token }));
import router from '@/routes/incident.routes';
const id = '10000000-0000-4000-8000-000000000001', sessionId = '20000000-0000-4000-8000-000000000002';
const endpoint = '/api/incidents/v1/nearby-detection';
const app = express().use(express.json()).use(cookieParser()).use('/api/incidents', router);
const body = { kind: 'citizen', latitude: 10.252191, longitude: 123.949475, services: ['FIRE'] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.token.mockReturnValue({ sub: id, sessionId, role: 'USER', type: 'access' });
  mocks.account.mockResolvedValue({ id, role: 'USER', status: 'ACTIVE', department: null, isMainAdmin: false, tokens: [{ id: sessionId }] });
  mocks.transaction.mockImplementation(fn => fn({ incident: { findFirst: mocks.first, findMany: mocks.many } }));
  mocks.many.mockResolvedValue([]);
});
it('requires authentication on the actual mounted read-only POST path', async () => {
  expect((await request(app).post(endpoint).send(body)).status).toBe(401);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it('validates the body before passing the current authoritative actor to detection', async () => {
  const result = await request(app).post(endpoint).set('Cookie', 'accessToken=synthetic').send(body);
  expect(result.status).toBe(200);
  expect(result.body.data).toEqual({ radiusMeters: 100, active: true, nearby: false, complete: true });
  expect(mocks.many.mock.calls[0][0].where.AND).toContainEqual({ reportedBy: { not: id } });
  mocks.transaction.mockClear();
  expect((await request(app).post(endpoint).set('Cookie', 'accessToken=synthetic').send({ ...body, radius: 1000 })).status).toBe(400);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it('does not let a stale admin claim bypass a deactivated or reassigned account', async () => {
  mocks.token.mockReturnValue({ sub: id, sessionId, role: 'ADMIN', type: 'access' });
  expect((await request(app).post(endpoint).set('Cookie', 'accessToken=synthetic').send({ kind: 'department', incidentId: id })).status).toBe(403);
  mocks.account.mockResolvedValue({ id, role: 'ADMIN', department: 'FIRE', isMainAdmin: false, status: 'INACTIVE', tokens: [{ id: sessionId }] });
  expect((await request(app).post(endpoint).set('Cookie', 'accessToken=synthetic').send({ kind: 'department', incidentId: id })).status).toBe(403);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
