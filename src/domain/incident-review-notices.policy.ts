import type { Department, IncidentReviewFlag, Prisma } from '@/generated/prisma';
import type { JwtPayload } from '@/lib/jwt';
import { departmentIncidentScope } from '@/domain/department-access.policy';
import { hasValidOperationalAssignment, isMainAdministrator } from '@/domain/permissions.policy';

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

export function presentIncidentReviews<T>(incident: T, ownDepartment?: ReviewNoticeScope, noticeDepartment?: ReviewNoticeScope) {
  const row = incident as T & { reviewFlags?: IncidentReviewFlag[]; reviewNotices?: unknown };
  const { reviewFlags, reviewNotices: _untrustedNotices, ...safe } = row;
  const flags = reviewFlags ?? [];
  return {
    ...safe,
    ...(ownDepartment && { reviewFlags: flags.filter(flag => flag.status !== 'DISMISSED'
      && (ownDepartment === 'ALL' || flag.department === ownDepartment)) }),
    ...(noticeDepartment && { reviewNotices: flags.map(flag => ({
      reviewFlagId: flag.reviewFlagId, department: flag.department, status: flag.status,
      reason: flag.reason, reviewNotes: flag.reviewNotes, createdAt: flag.createdAt,
      updatedAt: flag.updatedAt, reviewedAt: flag.reviewedAt,
    })) }),
  };
}
