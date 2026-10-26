import { afterEach, describe, expect, it, vi } from 'vitest';
import { departmentResponseQueueScope } from '@/lib/department-response-queue';

afterEach(() => vi.unstubAllEnvs());
describe('department Responding queue admission', () => {
  it('leaves the existing workflow unchanged until explicit-start mode is enabled', () => {
    vi.stubEnv('NEARBY_REVIEW_ENABLED', 'false');
    vi.stubEnv('NEARBY_RESPONSE_START_ENABLED', 'true');
    expect(departmentResponseQueueScope('FIRE')).toEqual({});
    vi.stubEnv('NEARBY_REVIEW_ENABLED', 'true');
    vi.stubEnv('NEARBY_RESPONSE_START_ENABLED', 'false');
    expect(departmentResponseQueueScope('MEDICAL')).toEqual({});
  });
  it.each(['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const)('%s requires its own normal acknowledgement or B start, never MAIN/another lane', service => {
    vi.stubEnv('NEARBY_REVIEW_ENABLED', 'true');
    vi.stubEnv('NEARBY_RESPONSE_START_ENABLED', 'true');
    expect(departmentResponseQueueScope(service)).toEqual({ OR: [
      { status: { not: 'RESPONDING' } },
      { serviceResponses: { none: { service, status: 'RESPONDING' } } },
      { OR: [
        { nearbyReviews: { some: { service, status: 'ACKNOWLEDGED', responseStart: { isNot: null } } } },
        { nearbyReviews: { none: { service } }, acknowledgements: { some: { scope: service } } },
      ] },
    ] });
  });
  it('Main monitoring requires an admitted currently-responding lane, without joining different lanes', () => {
    vi.stubEnv('NEARBY_REVIEW_ENABLED', 'true');
    vi.stubEnv('NEARBY_RESPONSE_START_ENABLED', 'true');
    const scope = departmentResponseQueueScope();
    expect(scope.OR).toHaveLength(6);
    for (const [index, service] of ['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'].entries()) {
      expect(scope.OR![index + 2]).toMatchObject({ AND: [
        { serviceResponses: { some: { service, status: 'RESPONDING' } } },
        { OR: [
          { nearbyReviews: { some: { service, status: 'ACKNOWLEDGED', responseStart: { isNot: null } } } },
          { nearbyReviews: { none: { service } }, acknowledgements: { some: { scope: service } } },
        ] },
      ] });
    }
  });
});
