import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectNearbyParents } from '@/domain/nearby-review.policy';
import { regularNearbyReviewScope, nearbyLaneAdmitted, nearbyLaneWaiting } from '@/lib/nearby-review';
import { mayDecideNearbyReview } from '@/services/incident/nearby-review-service';
import type { ResponseService } from '@/generated/prisma';
const point = { latitude: 10.251, longitude: 123.949 };
const candidate = (incidentId: string, seconds: number, latitude = point.latitude) => ({ incidentId, reportedAt: new Date(seconds * 1000),
  latitude, longitude: point.longitude, requestedServices: ['FIRE'] as ResponseService[], type: { typeName: 'Fire' },
  nearbyReviews: [] as Array<{ service: ResponseService; status: string }>, serviceResponses: [{ service: 'FIRE' as const, status: 'RESPONDING' }] });
afterEach(() => vi.unstubAllEnvs());
describe('nearby intake policy', () => {
  it('does not treat acknowledgment alone as operational admission or a new parent in explicit-start mode', () => {
    vi.stubEnv('NEARBY_REVIEW_ENABLED', 'true'); vi.stubEnv('NEARBY_RESPONSE_START_ENABLED', 'true');
    const waiting = { ...candidate('waiting', 1), nearbyReviews: [{ service: 'FIRE' as const, status: 'ACKNOWLEDGED', responseStart: null }] };
    expect(nearbyLaneAdmitted(waiting.nearbyReviews[0])).toBe(false);
    expect(nearbyLaneWaiting(waiting.nearbyReviews[0])).toBe(true);
    expect(selectNearbyParents([waiting], point.latitude, point.longitude, ['FIRE'], true)).toEqual([]);
    const admitted = { ...waiting, nearbyReviews: [{ ...waiting.nearbyReviews[0], responseStart: { reviewId: 'receipt' } }] };
    expect(nearbyLaneAdmitted(admitted.nearbyReviews[0])).toBe(true);
    expect(nearbyLaneWaiting(admitted.nearbyReviews[0])).toBe(false);
    expect(selectNearbyParents([admitted], point.latitude, point.longitude, ['FIRE'], true)).toEqual([{ service: 'FIRE', parentIncidentId: 'waiting' }]);
    expect(regularNearbyReviewScope('FIRE')).toMatchObject({ nearbyReviews: { none: { service: 'FIRE', OR: [{ status: 'PENDING' }, { status: 'ACKNOWLEDGED', responseStart: { is: null } }] } } });
  });
  it('chooses the original by receipt order, not the closest pin', () => {
    expect(selectNearbyParents([candidate('closest', 2), candidate('first', 1, 10.2515)], point.latitude, point.longitude, ['FIRE']))
      .toEqual([{ service: 'FIRE', parentIncidentId: 'first' }]);
  });
  it.each(['PENDING', 'REJECTED'])('does not chain a later report under a %s report', status => {
    const item = candidate('blocked', 1); item.nearbyReviews = [{ service: 'FIRE', status }];
    expect(selectNearbyParents([item], point.latitude, point.longitude, ['FIRE'])).toEqual([]);
  });
  it('accepts an acknowledged original and ignores another department', () => {
    const item = candidate('first', 1); item.nearbyReviews = [{ service: 'FIRE', status: 'ACKNOWLEDGED' }];
    expect(selectNearbyParents([item], point.latitude, point.longitude, ['MEDICAL', 'FIRE'])).toEqual([{ service: 'FIRE', parentIncidentId: 'first' }]);
  });
  it('does not hold a different service or a location outside 100m', () => {
    expect(selectNearbyParents([candidate('outside', 1, 10.252)], point.latitude, point.longitude, ['FIRE'])).toEqual([]);
    expect(selectNearbyParents([candidate('fire', 1)], point.latitude, point.longitude, ['MEDICAL'])).toEqual([]);
  });
  it.each(['RESOLVED', 'CANCELLED'])('does not use a %s department response as an original', status => {
    const item = candidate('finished', 1); item.serviceResponses[0].status = status;
    expect(selectNearbyParents([item], point.latitude, point.longitude, ['FIRE'])).toEqual([]);
  });
  it('breaks tied receipt times deterministically', () => {
    expect(selectNearbyParents([candidate('b', 1), candidate('a', 1)], point.latitude, point.longitude, ['FIRE'])[0].parentIncidentId).toBe('a');
  });
  it('leaves the old workflow untouched until explicitly enabled', () => {
    vi.stubEnv('NEARBY_REVIEW_ENABLED', 'false'); expect(regularNearbyReviewScope('FIRE')).toEqual({});
    vi.stubEnv('NEARBY_REVIEW_ENABLED', 'true'); expect(regularNearbyReviewScope('FIRE')).toEqual({ nearbyReviews: { none: { service: 'FIRE', status: 'PENDING' } } });
  });
  it.each(['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const)('grants final %s decisions only to its assigned admin', service => {
    const actor = { sub: 'synthetic', role: 'ADMIN', department: service === 'HAZARD' ? 'DRRMO' : service, isMainAdmin: false } as const;
    expect(mayDecideNearbyReview(actor, service)).toBe(true);
    expect(mayDecideNearbyReview({ ...actor, role: 'DISPATCHER' }, service)).toBe(false);
    expect(mayDecideNearbyReview({ ...actor, role: 'USER' }, service)).toBe(false);
    expect(mayDecideNearbyReview({ ...actor, department: 'MAIN', isMainAdmin: true }, service)).toBe(false);
    expect(mayDecideNearbyReview({ ...actor, department: service === 'FIRE' ? 'MEDICAL' : 'FIRE' }, service)).toBe(false);
  });
});
