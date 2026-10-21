import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma';

const state = vi.hoisted(() => ({
  ENV: { REPORT_REQUEST_CONTEXT_ENABLED: false, BACKGROUND_JOBS_ENABLED: false, LOCAL_REPORT_CONTEXT_WORKER_ENABLED: false },
  create: vi.fn(), query: vi.fn(), transaction: vi.fn(),
}));
vi.mock('@/config/env', () => ({ ENV: state.ENV }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: state.transaction } }));
import { REPORT_CONTEXT_RETENTION_MS, reportRequestContext, storeReportRequestContext, recentReportRequestContexts } from '@/lib/report-request-context';
import { REPORT_CONTEXT_BATCH_SIZE, previewReportContextExpiry, previewLegacyReportContext, expireReportContextBatch, processExpiredReportContexts, startReportContextRetentionWorker } from '@/lib/report-context-retention';

const tx = { $executeRaw: state.create, $queryRaw: state.query } as unknown as Prisma.TransactionClient;
const receipt = { auditLogId: '00000000-0000-0000-0000-000000000001', createdAt: new Date('2026-10-20T00:00:00.000Z') };
beforeEach(() => {
  vi.clearAllMocks(); state.ENV.REPORT_REQUEST_CONTEXT_ENABLED = false; state.ENV.BACKGROUND_JOBS_ENABLED = false;
  state.ENV.LOCAL_REPORT_CONTEXT_WORKER_ENABLED = false;
  state.create.mockResolvedValue({}); state.query.mockResolvedValue([]);
});

describe('minimized report request context', () => {
  it('validates IP, strips browser control characters and enforces the existing bound', () => {
    expect(reportRequestContext('2001:db8::1', 'Chrome\r\n\0Test')).toEqual({ ipAddress: '2001:db8::1', userAgent: 'ChromeTest' });
    expect(reportRequestContext('x-forwarded-for: forged', '')).toEqual({ ipAddress: undefined, userAgent: undefined });
    expect(reportRequestContext(undefined, 'x'.repeat(1000)).userAgent).toHaveLength(384);
  });
  it('does not access the new table with the feature off, including old schemas', async () => {
    await storeReportRequestContext(tx, receipt, { ipAddress: '127.0.0.1', userAgent: 'Synthetic browser' });
    expect(await recentReportRequestContexts(tx, [receipt.auditLogId])).toEqual(new Map());
    expect(state.create).not.toHaveBeenCalled(); expect(state.query).not.toHaveBeenCalled();
  });
  it('uses one database capture instant and a fixed 720-hour deadline, never a naive audit or client clock', async () => {
    state.ENV.REPORT_REQUEST_CONTEXT_ENABLED = true;
    await storeReportRequestContext(tx, receipt, { ipAddress: '127.0.0.1', userAgent: 'Test\nBrowser' });
    expect(REPORT_CONTEXT_RETENTION_MS).toBe(2_592_000_000);
    expect(state.create).toHaveBeenCalledTimes(1);
    const [strings, ...values] = state.create.mock.calls[0];
    expect(strings.join('')).toContain('statement_timestamp()::timestamptz(3)');
    expect(strings.join('')).toContain("instant + INTERVAL '720 hours'");
    expect(values).toEqual([receipt.auditLogId, '127.0.0.1', 'TestBrowser']);
    expect(values).not.toContain(receipt.createdAt);
  });
  it('stores nothing for empty/invalid context', async () => {
    state.ENV.REPORT_REQUEST_CONTEXT_ENABLED = true;
    await storeReportRequestContext(tx, receipt, { ipAddress: 'invalid', userAgent: '\r\n' });
    expect(state.create).not.toHaveBeenCalled();
  });
  it('propagates storage failure to roll back the receipt instead of writing raw data elsewhere', async () => {
    state.ENV.REPORT_REQUEST_CONTEXT_ENABLED = true; state.create.mockRejectedValueOnce(Error('synthetic insert failure'));
    await expect(storeReportRequestContext(tx, receipt, { userAgent: 'Browser' })).rejects.toThrow('synthetic insert failure');
  });
  it('reads only a bounded authorized receipt set and filters expiry using the database clock', async () => {
    state.ENV.REPORT_REQUEST_CONTEXT_ENABLED = true;
    state.query.mockResolvedValueOnce([{ auditLogId: receipt.auditLogId, ipAddress: '127.0.0.1', userAgent: 'Browser' }]);
    const result = await recentReportRequestContexts(tx, [receipt.auditLogId]);
    const [strings, ids] = state.query.mock.calls[0];
    expect(strings.join('')).toContain('expires_at > statement_timestamp()');
    expect((ids as Prisma.Sql).values).toContain(receipt.auditLogId);
    expect(result.get(receipt.auditLogId)).toEqual({ ipAddress: '127.0.0.1', userAgent: 'Browser' });
    await expect(recentReportRequestContexts(tx, Array(21).fill(receipt.auditLogId))).rejects.toThrow('READ_BOUND_EXCEEDED');
    expect(await recentReportRequestContexts(tx, [])).toEqual(new Map()); expect(state.query).toHaveBeenCalledTimes(1);
  });
});

describe('bounded context-only retention', () => {
  it('runs only the independent retention timer for validated local mode while general jobs stay off', async () => {
    vi.useFakeTimers();
    state.ENV.REPORT_REQUEST_CONTEXT_ENABLED = true; state.ENV.LOCAL_REPORT_CONTEXT_WORKER_ENABLED = true;
    state.transaction.mockResolvedValue({ deleted: 0 });
    const stop = startReportContextRetentionWorker();
    try {
      await vi.advanceTimersByTimeAsync(0); expect(state.transaction).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000); expect(state.transaction).toHaveBeenCalledTimes(2);
      expect(state.ENV.BACKGROUND_JOBS_ENABLED).toBe(false);
      stop?.(); await vi.advanceTimersByTimeAsync(60_000); expect(state.transaction).toHaveBeenCalledTimes(2);
    } finally { stop?.(); vi.useRealTimers(); }
  });
  it('starts no retention timer or transaction when capture is off', () => {
    vi.useFakeTimers();
    try { expect(startReportContextRetentionWorker()).toBeUndefined(); expect(vi.getTimerCount()).toBe(0); expect(state.transaction).not.toHaveBeenCalled(); }
    finally { vi.useRealTimers(); }
  });
  it('inventories only aggregate legacy report context without modifying or returning the raw values', async () => {
    state.query.mockResolvedValueOnce([{ action: 'INCIDENT_CREATED', records: 1, overThirtyDays: 1 }]);
    expect(await previewLegacyReportContext(tx)).toEqual([{ action: 'INCIDENT_CREATED', records: 1, overThirtyDays: 1 }]);
    const sql = state.query.mock.calls[0][0].join('');
    expect(sql).toContain('GROUP BY action'); expect(sql).not.toMatch(/UPDATE|DELETE|SELECT \*|SELECT ip_address/);
  });
  it('previews aggregate counts without issuing an UPDATE/DELETE or returning raw fields', async () => {
    state.query.mockResolvedValueOnce([{ expired: 2, oldestExpiry: receipt.createdAt }]);
    expect(await previewReportContextExpiry(tx)).toEqual({ expired: 2, oldestExpiry: receipt.createdAt });
    expect(state.query.mock.calls[0][0].join('')).not.toMatch(/DELETE|UPDATE|ip_address|user_agent|audit_logs/);
  });
  it('deletes at most one locked batch from the separate table, not audit/report/evidence history', async () => {
    state.query.mockResolvedValueOnce([{ deleted: 3 }]); expect(await expireReportContextBatch(tx)).toEqual({ deleted: 3 });
    const [strings, batchSize] = state.query.mock.calls[0], sql = strings.join('');
    expect(sql).toContain('DELETE FROM report_request_contexts'); expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('expires_at <= statement_timestamp()'); expect(batchSize).toBe(REPORT_CONTEXT_BATCH_SIZE);
    expect(sql).not.toMatch(/audit_logs|incidents|attachments|user_agent|ip_address|RETURNING \*/);
  });
  it('starts no transaction when either worker or feature is disabled', async () => {
    expect(await processExpiredReportContexts()).toEqual({ status: 'disabled' });
    state.ENV.REPORT_REQUEST_CONTEXT_ENABLED = true;
    expect(await processExpiredReportContexts()).toEqual({ status: 'disabled' });
    state.ENV.REPORT_REQUEST_CONTEXT_ENABLED = false; state.ENV.BACKGROUND_JOBS_ENABLED = true;
    expect(await processExpiredReportContexts()).toEqual({ status: 'disabled' });
    expect(state.transaction).not.toHaveBeenCalled();
  });
  it('avoids overlapping local runs and releases the guard after a failure for a safe retry', async () => {
    state.ENV.REPORT_REQUEST_CONTEXT_ENABLED = true; state.ENV.BACKGROUND_JOBS_ENABLED = true;
    let reject!: (error: Error) => void;
    state.transaction.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = processExpiredReportContexts();
    expect(await processExpiredReportContexts()).toEqual({ status: 'busy' });
    reject(Error('synthetic worker failure')); await expect(pending).rejects.toThrow('synthetic worker failure');
    state.transaction.mockResolvedValueOnce({ deleted: 0 });
    expect(await processExpiredReportContexts()).toEqual({ status: 'applied', deleted: 0 });
  });
});
