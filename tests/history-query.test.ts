import { afterEach, expect, it, vi } from 'vitest';
const list = vi.hoisted(() => vi.fn());
vi.mock('@/services/incident', () => ({ GetAllIncidentsService: list }));
import { IncidentController } from '@/controllers/incident.controller';
import { listIncidentsSchema } from '@/schema/incident/list-incidents.schema';
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it('uses server Manila month/year boundaries and preserves citizen scope', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-12-31T16:30:00Z'));
  list.mockResolvedValue({ code: 200, data: {} });
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await new IncidentController().getAll({ query: { period: 'THIS_MONTH', search: 'older', reportedBy: 'other-user', page: '2', limit: '50', includeUnits: 'true' }, user: { sub: 'citizen', role: 'USER' } } as never, response as never);
  expect(list).toHaveBeenCalledWith(expect.objectContaining({
    search: 'older', reportedBy: 'citizen', page: 2, limit: 50, includeUnits: true,
    historyFrom: new Date('2026-12-31T16:00:00Z'), historyBefore: new Date('2027-01-31T16:00:00Z'),
  }));
});
it('bounds search/type filters and rejects unrecognized periods and malformed pagination', () => {
  expect(listIncidentsSchema.safeParse({ query: { search: 'a'.repeat(161) } }).success).toBe(false);
  expect(listIncidentsSchema.safeParse({ query: { typeName: 'a'.repeat(121) } }).success).toBe(false);
  expect(listIncidentsSchema.safeParse({ query: { period: 'ANY', page: '1.5' } }).success).toBe(false);
  expect(listIncidentsSchema.safeParse({ query: { search: 'older', period: 'THIS_MONTH', status: 'RESPONDING', page: '2' } }).success).toBe(true);
});
