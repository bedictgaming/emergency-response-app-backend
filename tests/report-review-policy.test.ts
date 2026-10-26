import { afterEach, describe, expect, it, vi } from 'vitest';
import { canDecideReportReview, wholeReportConfirmedFalse, wholeFalseWhere, reportReviewCapabilities, wholeFalseAttentionSql } from '@/domain/report-review.policy';
import { presentIncidentReviews } from '@/domain/incident-review-notices.policy';
import { verifiedAnalyticsEligibility } from '@/domain/verified-analytics.policy';
import * as configured from '@/lib/report-review';

const main = { sub: 'synthetic-main', type: 'access', role: 'ADMIN', department: 'MAIN', isMainAdmin: true } as const;
const fire = { ...main, sub: 'synthetic-fire', department: 'FIRE', isMainAdmin: false } as const;
const report = { requestedServices: ['FIRE', 'MEDICAL'], serviceResponses: [{ service: 'FIRE' }, { service: 'MEDICAL' }],
  reviewFlags: [{ status: 'CONFIRMED', department: 'FIRE', reviewAuthority: 'DEPARTMENT' }] };

afterEach(() => vi.unstubAllEnvs());

describe('explicit report-review policy mode', () => {
  it('keeps pure decisions independent of ambient configuration in both modes', () => {
    for (const ambient of ['true', 'false']) {
      vi.stubEnv('DEPARTMENT_REPORT_REVIEW_ENABLED', ambient);
      expect(canDecideReportReview(main, false)).toBe(true);
      expect(canDecideReportReview(fire, false)).toBe(false);
      expect(canDecideReportReview(main, true)).toBe(false);
      expect(canDecideReportReview(fire, true)).toBe(true);
      expect(wholeReportConfirmedFalse(report, false)).toBe(true);
      expect(wholeReportConfirmedFalse(report, true)).toBe(false);
      expect(wholeFalseWhere(false)).toEqual({ reviewFlags: { some: { status: 'CONFIRMED' } } });
      expect(verifiedAnalyticsEligibility(false)).toEqual({ verificationStatus: 'VERIFIED', status: { not: 'CANCELLED' },
        NOT: { reviewFlags: { some: { status: 'CONFIRMED' } } } });
      expect(wholeFalseAttentionSql(false).sql).not.toContain('review_authority');
      expect(wholeFalseAttentionSql(true).sql).toContain('review_authority');
    }
  });
  it('retains all-service consensus, dismissal veto and separate review authority', () => {
    const unanimous = { ...report, reviewFlags: [...report.reviewFlags, { status: 'CONFIRMED', department: 'MEDICAL', reviewAuthority: 'DEPARTMENT' }] };
    expect(wholeReportConfirmedFalse(unanimous, true)).toBe(true);
    expect(wholeReportConfirmedFalse({ ...unanimous, reviewFlags: [...unanimous.reviewFlags,
      { status: 'DISMISSED', department: 'MEDICAL', reviewAuthority: 'DEPARTMENT' }] }, true)).toBe(false);
    expect(reportReviewCapabilities(unanimous, main, true)).toMatchObject({ readOnly: true, canFlag: false, canReview: false, canCancelFalse: false, wholeConfirmedFalse: true });
    expect(reportReviewCapabilities(unanimous, fire, true)).toMatchObject({ readOnly: false, canReview: true, canCancelFalse: true });
    expect(reportReviewCapabilities(unanimous, { ...fire, department: 'POLICE' }, true)).toMatchObject({ readOnly: true, canFlag: false });
  });
  it('binds deployment mode at the application boundary without changing pure policies', () => {
    for (const enabled of [false, true]) {
      vi.stubEnv('DEPARTMENT_REPORT_REVIEW_ENABLED', String(enabled));
      expect(configured.departmentReportReviewEnabled()).toBe(enabled);
      expect(configured.canDecideReportReview(fire)).toBe(canDecideReportReview(fire, enabled));
      expect(configured.wholeReportConfirmedFalse(report)).toBe(wholeReportConfirmedFalse(report, enabled));
      expect(configured.wholeFalseWhere()).toEqual(wholeFalseWhere(enabled));
      expect(configured.wholeFalseAttentionSql()).toEqual(wholeFalseAttentionSql(enabled));
      expect(configured.reportReviewCapabilities(report, main)).toEqual(reportReviewCapabilities(report, main, enabled));
      expect(configured.presentIncidentReviews(report, 'ALL', 'ALL')).toEqual(presentIncidentReviews(report, enabled, 'ALL', 'ALL'));
    }
  });
});
