import { beforeEach, expect, it, vi } from 'vitest';
import { IncidentUnitRepository } from '@/repositories/incident-unit.repository';
import { GetIncidentUnitsService } from '@/services/incident-unit/get-incident-units-service';
import { GetIncidentUnitService } from '@/services/incident-unit/get-incident-unit-service';

beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it('scopes responder dispatch listings to their own unit', async () => {
  const find = vi.spyOn(IncidentUnitRepository.prototype, 'findAll').mockResolvedValue([]);
  expect((await GetIncidentUnitsService({}, 'responder', 'RESPONDER')).code).toBe(200);
  expect(find).toHaveBeenCalledWith({ assignedUserId: 'responder' });
});

it('blocks direct reads of another unit dispatch', async () => {
  vi.spyOn(IncidentUnitRepository.prototype, 'findById').mockResolvedValue({ unit: { responders: [{ user: { id: 'other' } }] } } as never);
  expect((await GetIncidentUnitService('dispatch', 'responder', 'RESPONDER')).code).toBe(403);
});
