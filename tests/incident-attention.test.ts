import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn(), user: vi.fn(), list: vi.fn(), incident: vi.fn(), ack: vi.fn(), findAck: vi.fn(), audit: vi.fn(), publish: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/events', () => ({ publishEmergencyEvent: mocks.publish }));
import { attentionScope, attentionVersion, listIncidentAttention, acknowledgeIncidentAttention } from '@/services/incident/incident-attention-service';
const actor = { sub: 'staff', sessionId: 'session', type: 'access' as const, role: 'ADMIN', department: 'FIRE' as const, isMainAdmin: false };
const incident = { incidentId: '00000000-0000-0000-0000-000000000001', status: 'RESPONDING', verificationStatus: 'VERIFIED', attentionVersion: 2, serviceResponses: [{ service: 'FIRE', status: 'RESOLVED', attentionVersion: 1 }, { service: 'MEDICAL', status: 'RESPONDING', attentionVersion: 2 }] };
beforeEach(() => {
  vi.resetAllMocks(); mocks.user.mockResolvedValue({ ...actor, status: 'ACTIVE', tokens: [{ id: 'session' }] });
  mocks.query.mockResolvedValue([]); mocks.list.mockResolvedValue([]); mocks.incident.mockResolvedValue(incident);
  mocks.transaction.mockImplementation(async callback => callback({ $queryRaw: mocks.query, user: { findUnique: mocks.user }, incident: { findMany: mocks.list, findFirst: mocks.incident }, incidentAcknowledgement: { upsert: mocks.ack, findUnique: mocks.findAck }, auditLog: { create: mocks.audit } }));
});
it('scopes all four departments and rejects citizen, malformed MAIN and cross-service requests', () => {
  for (const [department, scope] of [['FIRE','FIRE'],['MEDICAL','MEDICAL'],['POLICE','POLICE'],['DRRMO','HAZARD']] as const) expect(attentionScope({ ...actor, department })).toBe(scope);
  expect(attentionScope({ ...actor, role: 'USER' })).toBeNull();
  expect(attentionScope({ ...actor, department: 'MAIN' })).toBeNull();
  expect(attentionScope(actor, 'MEDICAL')).toBeNull();
  expect(attentionScope({ ...actor, department: 'MAIN', isMainAdmin: true })).toBe('MAIN');
});
it('does not confuse department completion with overall unfinished work', () => {
  expect(attentionVersion(incident, 'FIRE')).toBeNull(); expect(attentionVersion(incident, 'MEDICAL')).toBe(2); expect(attentionVersion(incident, 'MAIN')).toBe(2);
});
it.each([{ status: 'RESOLVED' }, { status: 'CLOSED' }, { verificationStatus: 'PENDING' }, { verificationStatus: 'REJECTED' }, { mergedIntoId: 'target' }])('never alarms handled/unverified/merged records %j', changes => {
  expect(attentionVersion({ ...incident, ...changes }, 'MAIN')).toBeNull();
});
it('returns 50 oldest queued items with explicit remaining work, not a newest-ten window', async () => {
  const ids = Array.from({ length: 51 }, (_, index) => ({ incidentId: String(index), version: 1 }));
  mocks.query.mockResolvedValue(ids); mocks.list.mockResolvedValue(ids.map(item => ({ incidentId: item.incidentId })));
  const result = await listIncidentAttention(actor);
  expect(result?.items).toHaveLength(50); expect(result?.hasMore).toBe(true); expect(result?.items[0].incidentId).toBe('0');
  const sql = mocks.query.mock.calls[0][0]; expect(sql.text).toContain('NOT EXISTS'); expect(sql.text).toContain('ORDER BY i.reported_at ASC'); expect(sql.text).toContain('LIMIT 51');
  expect(sql.values).toContain('staff'); expect(sql.values).toContain('FIRE');
});
it('rechecks role before querying private attention data', async () => {
  mocks.user.mockResolvedValue({ ...actor, role: 'USER', status: 'ACTIVE', tokens: [{ id: 'session' }] });
  expect(await listIncidentAttention(actor)).toBeNull(); expect(mocks.query).not.toHaveBeenCalled();
});
it('rejects stale-version acknowledgements and completed department work', async () => {
  expect(await acknowledgeIncidentAttention(actor, incident.incidentId, 1)).toBe(409); expect(mocks.ack).not.toHaveBeenCalled();
  mocks.incident.mockResolvedValue({ ...incident, serviceResponses: [{ service: 'FIRE', status: 'RESPONDING', attentionVersion: 2 }] });
  expect(await acknowledgeIncidentAttention(actor, incident.incidentId, 1)).toBe(409); expect(mocks.ack).not.toHaveBeenCalled();
});
it('persists only one personal/versioned acknowledgement, without workflow writes', async () => {
  mocks.incident.mockResolvedValue({ ...incident, serviceResponses: [{ service: 'FIRE', status: 'RESPONDING', attentionVersion: 2 }] });
  expect(await acknowledgeIncidentAttention(actor, incident.incidentId, 2)).toBe(200);
  expect(mocks.ack).toHaveBeenCalledWith(expect.objectContaining({ create: { userId: 'staff', incidentId: incident.incidentId, scope: 'FIRE', version: 2 } }));
});
