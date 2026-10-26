import type { Prisma } from '@/generated/prisma';
import { wholeFalseWhere } from '@/domain/report-review.policy';

// Review classification is separate from response status and record retention.
export function verifiedAnalyticsEligibility(departmentReviewEnabled: boolean): Prisma.IncidentWhereInput {
  return {
    verificationStatus: 'VERIFIED',
    status: { not: 'CANCELLED' },
    NOT: wholeFalseWhere(departmentReviewEnabled),
  };
}
