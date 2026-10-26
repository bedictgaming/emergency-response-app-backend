import { Prisma } from '@/generated/prisma';
import type { JwtPayload } from '@/lib/jwt';
import { departmentService } from '@/domain/department-access.policy';
import { hasValidOperationalAssignment, isMainAdministrator } from '@/domain/permissions.policy';

const lanes = [{ service: 'FIRE', department: 'FIRE' }, { service: 'MEDICAL', department: 'MEDICAL' },
  { service: 'POLICE', department: 'POLICE' }, { service: 'HAZARD', department: 'DRRMO' }] as const;
export function canDecideReportReview(actor: JwtPayload, departmentReviewEnabled: boolean) {
  return departmentReviewEnabled
    ? actor.role === 'ADMIN' && hasValidOperationalAssignment(actor) && !isMainAdministrator(actor)
    : isMainAdministrator(actor);
}
type Flag = { status: string; department?: string; reviewAuthority?: string };
export type ReportReviewAssessment = { requestedServices?: readonly string[]; serviceResponses?: readonly { service: string }[]; reviewFlags?: readonly Flag[] };
/** One whole-report decision, never one strike per service. Legacy decisions retain provenance. */
export function wholeReportConfirmedFalse(report: ReportReviewAssessment, departmentReviewEnabled: boolean) {
  const flags = report.reviewFlags ?? [];
  if (!departmentReviewEnabled) return flags.some(flag => flag.status === 'CONFIRMED');
  const assigned = lanes.filter(lane => report.requestedServices?.includes(lane.service) || report.serviceResponses?.some(row => row.service === lane.service));
  if (assigned.some(lane => flags.some(flag => flag.department === lane.department && flag.reviewAuthority === 'DEPARTMENT' && flag.status === 'DISMISSED'))) return false;
  if (flags.some(flag => flag.status === 'CONFIRMED' && (flag.reviewAuthority ?? 'MAIN') === 'MAIN')) return true;
  return assigned.length > 0 && assigned.every(lane => report.serviceResponses?.some(row => row.service === lane.service)
    && flags.some(flag => flag.department === lane.department && flag.reviewAuthority === 'DEPARTMENT' && flag.status === 'CONFIRMED'));
}
const assignedWhere = (lane: typeof lanes[number]): Prisma.IncidentWhereInput => ({ OR: [
  { requestedServices: { has: lane.service } }, { serviceResponses: { some: { service: lane.service } } },
] });
/** SQL equivalent of wholeReportConfirmedFalse: used before pagination/counting. */
export function wholeFalseWhere(departmentReviewEnabled: boolean): Prisma.IncidentWhereInput {
  if (!departmentReviewEnabled) return { reviewFlags: { some: { status: 'CONFIRMED' } } };
  return { AND: [
    ...lanes.map((lane): Prisma.IncidentWhereInput => ({ NOT: { AND: [assignedWhere(lane), { reviewFlags: { some: { department: lane.department, reviewAuthority: 'DEPARTMENT', status: 'DISMISSED' } } }] } })),
    { OR: [
      { reviewFlags: { some: { status: 'CONFIRMED', reviewAuthority: 'MAIN' } } },
      { AND: [
        { OR: lanes.map(assignedWhere) },
        ...lanes.map((lane): Prisma.IncidentWhereInput => ({ OR: [
          { NOT: assignedWhere(lane) },
          { AND: [{ serviceResponses: { some: { service: lane.service } } }, { reviewFlags: { some: { department: lane.department, reviewAuthority: 'DEPARTMENT', status: 'CONFIRMED' } } }] },
        ] })),
      ] },
    ] },
  ] };
}
/** Same predicate for the attention query's fixed, internal incident alias i. */
export function wholeFalseAttentionSql(departmentReviewEnabled: boolean): Prisma.Sql {
  const confirmed = Prisma.sql`EXISTS (SELECT 1 FROM incident_review_flags f WHERE f.incident_id=i.incident_id AND f.status='CONFIRMED')`;
  if (!departmentReviewEnabled) return confirmed;
  const assigned = (service: string) => Prisma.sql`(${service}::"ResponseService" = ANY(i.requested_services)
    OR EXISTS (SELECT 1 FROM incident_service_responses r WHERE r.incident_id=i.incident_id AND r.service=${service}::"ResponseService"))`;
  return Prisma.sql`(
    ${Prisma.join(lanes.map(lane => Prisma.sql`NOT (${assigned(lane.service)} AND EXISTS (
      SELECT 1 FROM incident_review_flags f WHERE f.incident_id=i.incident_id AND f.department=${lane.department}::"Department"
        AND f.review_authority='DEPARTMENT' AND f.status='DISMISSED'))`), ' AND ')}
    AND (EXISTS (SELECT 1 FROM incident_review_flags f WHERE f.incident_id=i.incident_id AND f.status='CONFIRMED' AND f.review_authority='MAIN')
      OR ((${Prisma.join(lanes.map(lane => assigned(lane.service)), ' OR ')})
        AND ${Prisma.join(lanes.map(lane => Prisma.sql`(NOT ${assigned(lane.service)} OR (
          EXISTS (SELECT 1 FROM incident_service_responses r WHERE r.incident_id=i.incident_id AND r.service=${lane.service}::"ResponseService")
          AND EXISTS (SELECT 1 FROM incident_review_flags f WHERE f.incident_id=i.incident_id AND f.department=${lane.department}::"Department"
            AND f.review_authority='DEPARTMENT' AND f.status='CONFIRMED')))`), ' AND ')}))
  )`;
}
export function reportReviewCapabilities(report: ReportReviewAssessment, actor: JwtPayload, enabled: boolean) {
  const decider = canDecideReportReview(actor, enabled);
  const service = departmentService(actor.department);
  const assigned = !!service && (!!report.requestedServices?.includes(service) || !!report.serviceResponses?.some(row => row.service === service));
  const canReview = decider && (!enabled || assigned);
  return { departmentReviewEnabled: enabled, readOnly: enabled && !canReview, canFlag: canReview,
    canReview, canCorrect: canReview, canCancelFalse: canReview && wholeReportConfirmedFalse(report, enabled),
    wholeConfirmedFalse: wholeReportConfirmedFalse(report, enabled) };
}
