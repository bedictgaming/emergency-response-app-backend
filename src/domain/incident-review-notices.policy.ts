import type { Department, IncidentReviewFlag, Prisma } from '@/generated/prisma';
import type { JwtPayload } from '@/lib/jwt';
import { departmentIncidentScope } from '@/domain/department-access.policy';
import { hasValidOperationalAssignment, isMainAdministrator } from '@/domain/permissions.policy';
import { reportReviewCapabilities, type ReportReviewAssessment } from '@/domain/report-review.policy';

export type ReviewNoticeScope = Department | 'ALL';

// Read-only coordination context, not permission to create or decide a flag.
export function reviewNoticeDepartmentFor(actor: JwtPayload): ReviewNoticeScope | undefined {
  if (!['ADMIN', 'DISPATCHER'].includes(actor.role) || !hasValidOperationalAssignment(actor)) return undefined;
  if (isMainAdministrator(actor)) return 'ALL';
  return actor.department && ['FIRE', 'MEDICAL', 'POLICE', 'DRRMO'].includes(actor.department)
    ? actor.department : undefined;
}

export function reviewNoticeIncidentScope(department: ReviewNoticeScope): Prisma.IncidentWhereInput {
  return department === 'ALL' ? {} : departmentIncidentScope({ role: 'ADMIN', department, isMainAdmin: false });
}

export function presentIncidentReviews<T>(incident: T, departmentReviewEnabled: boolean, ownDepartment?: ReviewNoticeScope, noticeDepartment?: ReviewNoticeScope) {
  const row = incident as T & Omit<ReportReviewAssessment, 'reviewFlags'> & { reviewFlags?: IncidentReviewFlag[]; reviewNotices?: unknown; reportReview?: unknown };
  const { reviewFlags, reviewNotices: _untrustedNotices, reportReview: _untrustedCapabilities, ...safe } = row;
  const flags = reviewFlags ?? [];
  return {
    ...safe,
    ...(departmentReviewEnabled && noticeDepartment && { reportReview: reportReviewCapabilities(row, {
      sub: '', type: 'access', role: ownDepartment ? 'ADMIN' : 'DISPATCHER',
      department: (ownDepartment === 'ALL' ? 'MAIN' : ownDepartment) ?? (noticeDepartment === 'ALL' ? 'MAIN' : noticeDepartment),
      isMainAdmin: ownDepartment === 'ALL',
    }, departmentReviewEnabled) }),
    ...(ownDepartment && { reviewFlags: flags.filter(flag => flag.status !== 'DISMISSED'
      && (ownDepartment === 'ALL' || flag.department === ownDepartment)) }),
    ...(noticeDepartment && { reviewNotices: flags.map(flag => ({
      reviewFlagId: flag.reviewFlagId, department: flag.department, status: flag.status,
      reason: flag.reason, reviewNotes: flag.reviewNotes, createdAt: flag.createdAt,
      updatedAt: flag.updatedAt, reviewedAt: flag.reviewedAt,
      reviewAuthority: flag.reviewAuthority,
      ...(departmentReviewEnabled && { departmentReviewEnabled: true }),
    })) }),
  };
}
