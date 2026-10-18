import { ResponseService } from '@/generated/prisma';

export const CITIZEN_REPORT_WINDOW_MS = 5 * 60 * 1000;
export const CITIZEN_REPORT_SEQUENCE_ACTION = 'CITIZEN_REPORT_SEQUENCE_STATE';
export const CITIZEN_REPORT_LIMIT_CODE = 'CITIZEN_REPORT_SEQUENCE_LIMIT';
export type CitizenReportReceipt = { incidentId: string; submittedAt: number; services: ResponseService[] };

/** Server-owned, bounded receipt state. Missing legacy state starts fresh. */
export function readCitizenReportSequence(metadata: unknown): CitizenReportReceipt[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw Error('INVALID_CITIZEN_REPORT_SEQUENCE');
  const state = metadata as { version?: unknown; reports?: unknown };
  if (state.version !== 1 || !Array.isArray(state.reports) || state.reports.length > 2) throw Error('INVALID_CITIZEN_REPORT_SEQUENCE');
  return state.reports.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_CITIZEN_REPORT_SEQUENCE');
    const report = value as CitizenReportReceipt;
    if (typeof report.incidentId !== 'string' || !report.incidentId || report.incidentId.length > 100
        || !Number.isSafeInteger(report.submittedAt) || report.submittedAt < 0
        || !Array.isArray(report.services) || report.services.length > 4
        || report.services.some(service => !Object.values(ResponseService).includes(service))
        || new Set(report.services).size !== report.services.length) throw Error('INVALID_CITIZEN_REPORT_SEQUENCE');
    return { incidentId: report.incidentId, submittedAt: report.submittedAt, services: [...report.services] };
  });
}

/** Three consecutive distinct accepted reports sharing a routed department. */
export function citizenReportViolation(previous: CitizenReportReceipt[], current: CitizenReportReceipt): ResponseService[] {
  const reports = [...previous, current];
  if (reports.length !== 3 || new Set(reports.map(report => report.incidentId)).size !== 3
      || reports.some(report => current.submittedAt - report.submittedAt < 0
        || current.submittedAt - report.submittedAt > CITIZEN_REPORT_WINDOW_MS)) return [];
  return [...new Set(current.services)].filter(service => reports.every(report => report.services.includes(service))).sort();
}
