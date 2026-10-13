import type { Incident, IncidentReviewFlag } from '@/generated/prisma';
import { WorkflowConflict } from '@/domain/workflow-error.policy';

export type FalseReportVersion = {
  reviewFlagId: string;
  expectedReviewUpdatedAt: string;
  expectedIncidentUpdatedAt: string;
};
export function validFalseReportVersion(input: FalseReportVersion) {
  return typeof input?.reviewFlagId === 'string' && !!input.reviewFlagId
    && typeof input.expectedReviewUpdatedAt === 'string' && Number.isFinite(Date.parse(input.expectedReviewUpdatedAt))
    && typeof input.expectedIncidentUpdatedAt === 'string' && Number.isFinite(Date.parse(input.expectedIncidentUpdatedAt));
}
export function requireConfirmedFalseReport(incident: Pick<Incident, 'incidentId' | 'mergedIntoId' | 'updatedAt'> & { reviewFlags: IncidentReviewFlag[] }, input: FalseReportVersion, allowCancelledRetry = false) {
  if (incident.mergedIntoId) throw new WorkflowConflict('A merged report cannot use the confirmed-false disposition.');
  const flag = incident.reviewFlags.find(item => item.reviewFlagId === input.reviewFlagId && item.incidentId === incident.incidentId);
  if (!flag || flag.status !== 'CONFIRMED' || flag.updatedAt.toISOString() !== input.expectedReviewUpdatedAt)
    throw new WorkflowConflict('The false-report decision changed. Refresh and review it before continuing.');
  if (!allowCancelledRetry && incident.updatedAt.toISOString() !== input.expectedIncidentUpdatedAt)
    throw new WorkflowConflict('The report changed. Refresh before cancelling or deleting it.');
  return flag;
}
