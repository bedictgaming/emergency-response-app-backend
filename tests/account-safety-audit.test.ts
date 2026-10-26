import { describe, expect, it } from 'vitest';
import { presentSafetyReviewAudit, SAFETY_REVIEW_ACTIONS } from '@/lib/account-safety-audit';

const row = { auditLogId: 'synthetic-audit', entityId: 'synthetic-report', action: 'INCIDENT_FLAG_REVIEWED', createdAt: new Date('2026-10-23T05:00:00Z'),
  actor: { id: 'synthetic-main', name: 'Synthetic Main' }, metadata: null };
describe('Main account safety review audit projection', () => {
  it('returns only the specific actor/decision/explanation fields, not raw metadata', () => {
    const result = presentSafetyReviewAudit({ ...row, metadata: { status: 'CONFIRMED', reviewNotes: 'Evidence reviewed.', reason: 'Original flag', department: 'FIRE',
      ipAddress: '192.0.2.1', userAgent: 'Synthetic browser', unrelatedSecret: 'synthetic-only' } });
    expect(result).toEqual({ auditLogId: row.auditLogId, incidentId: row.entityId, action: row.action, createdAt: row.createdAt,
      actor: row.actor, reason: 'Evidence reviewed.', decision: 'CONFIRMED', department: 'FIRE' });
    expect(JSON.stringify(result)).not.toContain('synthetic-only');
  });
  it('retains nearby service/rejection reason and handles unavailable actors', () => {
    expect(presentSafetyReviewAudit({ ...row, actor: null, metadata: { reason: 'Nearby review explanation', service: 'MEDICAL' } }))
      .toMatchObject({ actor: null, reason: 'Nearby review explanation', department: 'MEDICAL', decision: null });
  });
  it('does not fabricate explanations from missing, array or malformed metadata', () => {
    for (const metadata of [null, [], { reason: false, reviewNotes: 123, department: {} }]) {
      expect(presentSafetyReviewAudit({ ...row, metadata })).toMatchObject({ reason: null, department: null, decision: null });
    }
  });
  it('allows review actions only, never password, session or request-context records', () => {
    expect(SAFETY_REVIEW_ACTIONS).toEqual(['INCIDENT_FLAGGED', 'INCIDENT_FLAG_REVIEWED', 'INCIDENT_FLAG_CORRECTED', 'NEARBY_REPORT_ACKNOWLEDGED', 'NEARBY_REPORT_REJECTED']);
  });
});
