import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), publish: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/events', () => ({ publishEmergencyEvent: mocks.publish }));
import { IncidentUnitRepository } from '@/repositories/incident-unit.repository';
import { UnitRepository } from '@/repositories/unit.repository';
import { UpdateIncidentUnitService } from '@/services/incident-unit/update-incident-unit-service';
import { UpdateUnitService } from '@/services/unit/update-unit-service';
import { signRefreshToken, TokenExpiry } from '@/lib/jwt';
beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it('returns conflict when dispatch status changed after reading', async () => {
  vi.spyOn(IncidentUnitRepository.prototype, 'findById').mockResolvedValue({ status: 'DISPATCHED', unit: { unitId: 'unit', responders: [] } } as never);
  const update = vi.fn().mockRejectedValue({ code: 'P2025' });
  mocks.transaction.mockImplementation(callback => callback({ $queryRaw: vi.fn(), incidentUnit: { update } }));
  expect((await UpdateIncidentUnitService('dispatch', { status: 'EN_ROUTE' }, 'operator', 'ADMIN')).code).toBe(409);
  expect(update.mock.calls[0][0].where.status).toBe('DISPATCHED');
  expect(mocks.publish).not.toHaveBeenCalled();
});
it('prevents manual availability changes while a unit is dispatched', async () => {
  vi.spyOn(UnitRepository.prototype, 'findById').mockResolvedValue({ status: 'DEPLOYED' } as never);
  const update = vi.fn();
  mocks.transaction.mockImplementation(callback => callback({ $queryRaw: vi.fn(), incidentUnit: { count: vi.fn().mockResolvedValue(1) }, unit: { update } }));
  expect((await UpdateUnitService('unit', { status: 'AVAILABLE' })).code).toBe(409);
  expect(update).not.toHaveBeenCalled();
});
it('refresh tokens minted in the same second are unique', () => {
  expect(signRefreshToken('user', 'USER', TokenExpiry.REFRESH_TOKEN_EXPIRES)).not.toBe(signRefreshToken('user', 'USER', TokenExpiry.REFRESH_TOKEN_EXPIRES));
});
