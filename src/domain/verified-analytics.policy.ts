import type { Prisma } from '@/generated/prisma';

// Review classification is separate from response status and record retention.
export const verifiedAnalyticsEligibility: Prisma.IncidentWhereInput = {
  verificationStatus: 'VERIFIED',
  status: { not: 'CANCELLED' },
  reviewFlags: { none: { status: 'CONFIRMED' } },
};
