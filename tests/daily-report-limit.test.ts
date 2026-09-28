import { describe, expect, it } from 'vitest';
import { DAILY_CITIZEN_REPORT_LIMIT, getManilaDayRange } from '@/lib/daily-report-limit';

describe('daily citizen report limit', () => {
  it('allows two reports per day', () => {
    expect(DAILY_CITIZEN_REPORT_LIMIT).toBe(2);
  });

  it('resets at midnight in Asia/Manila', () => {
    const { start, end } = getManilaDayRange(new Date('2026-09-11T20:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-09-11T16:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-12T16:00:00.000Z');
  });
});
