import type { JwtPayload } from '@/lib/jwt';
import { departmentReportReviewEnabled } from '@/config/report-review';
import {
  canDecideReportReview as canDecide,
  wholeReportConfirmedFalse as confirmedFalse,
  wholeFalseWhere as falseWhere,
  wholeFalseAttentionSql as falseAttentionSql,
  reportReviewCapabilities as capabilities,
  type ReportReviewAssessment,
} from '@/domain/report-review.policy';
import { presentIncidentReviews as presentReviews, type ReviewNoticeScope } from '@/domain/incident-review-notices.policy';
import { verifiedAnalyticsEligibility as analyticsEligibility } from '@/domain/verified-analytics.policy';

export { departmentReportReviewEnabled } from '@/config/report-review';
export { reviewNoticeDepartmentFor, reviewNoticeIncidentScope, type ReviewNoticeScope } from '@/domain/incident-review-notices.policy';

// Bind deployment configuration outside the pure policy tree. Preserve the
// runtime call contracts and the existing import-time analytics predicate.
export const canDecideReportReview = (actor: JwtPayload) => canDecide(actor, departmentReportReviewEnabled());
export const wholeReportConfirmedFalse = (report: ReportReviewAssessment) => confirmedFalse(report, departmentReportReviewEnabled());
export const wholeFalseWhere = () => falseWhere(departmentReportReviewEnabled());
export const wholeFalseAttentionSql = () => falseAttentionSql(departmentReportReviewEnabled());
export const reportReviewCapabilities = (report: ReportReviewAssessment, actor: JwtPayload) => capabilities(report, actor, departmentReportReviewEnabled());
export function presentIncidentReviews<T>(incident: T, ownDepartment?: ReviewNoticeScope, noticeDepartment?: ReviewNoticeScope) {
  return presentReviews(incident, departmentReportReviewEnabled(), ownDepartment, noticeDepartment);
}
export const verifiedAnalyticsEligibility = analyticsEligibility(departmentReportReviewEnabled());
