import { describe, expect, it } from 'vitest';
import { verifyIncidentSchema } from '@/schema/incident/verify-incident.schema';

const id = 'b88dc364-68a7-4f44-9755-ff86d144343b';

describe('incident verification validation', () => {
  it('accepts verification', () => {
    expect(verifyIncidentSchema.safeParse({ params: { id }, body: { verificationStatus: 'VERIFIED' } }).success).toBe(true);
  });

  it('requires notes for rejection', () => {
    expect(verifyIncidentSchema.safeParse({ params: { id }, body: { verificationStatus: 'REJECTED' } }).success).toBe(false);
    expect(verifyIncidentSchema.safeParse({ params: { id }, body: { verificationStatus: 'REJECTED', verificationNotes: 'Duplicate report' } }).success).toBe(true);
  });
});
