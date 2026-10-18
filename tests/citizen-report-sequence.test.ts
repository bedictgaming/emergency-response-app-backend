import { describe, expect, it, vi } from 'vitest';
import type { Prisma, ResponseService } from '@/generated/prisma';
import { citizenReportViolation, readCitizenReportSequence, CITIZEN_REPORT_SEQUENCE_ACTION } from '@/domain/citizen-report-sequence.policy';
import { recordCitizenReportSequence, resetCitizenReportSequence } from '@/lib/citizen-report-sequence';

const now = 1_800_000_000_000;
const report = (id: string, services: ResponseService[] = ['MEDICAL'], time = now) => ({ incidentId: id, services, submittedAt: time });
describe('citizen same-department consecutive report rule', () => {
  it.each(['FIRE', 'MEDICAL', 'POLICE', 'HAZARD'] as const)('restricts the third accepted %s report, including the five-minute boundary', service => {
    expect(citizenReportViolation([report('a', [service], now - 300000), report('b', [service], now - 1000)], report('c', [service]))).toEqual([service]);
  });
  it('does not restrict one/two reports or reports outside five minutes', () => {
    expect(citizenReportViolation([], report('a'))).toEqual([]);
    expect(citizenReportViolation([report('a')], report('b'))).toEqual([]);
    expect(citizenReportViolation([report('a', ['MEDICAL'], now - 300001), report('b')], report('c'))).toEqual([]);
  });
  it('an intervening department or unknown legacy routing breaks the streak', () => {
    expect(citizenReportViolation([report('a'), report('b', ['FIRE'])], report('c'))).toEqual([]);
    expect(citizenReportViolation([report('a'), report('b', [])], report('c'))).toEqual([]);
  });
  it('uses common routed services, including Other, rather than matching category text', () => {
    expect(citizenReportViolation([report('a', ['MEDICAL','FIRE']), report('b', ['FIRE','HAZARD'])], report('c', ['POLICE','FIRE']))).toEqual(['FIRE']);
    expect(citizenReportViolation([report('a', ['FIRE']), report('b', ['MEDICAL'])], report('c', ['FIRE','MEDICAL']))).toEqual([]);
  });
  it('does not treat the same incident or future/skewed time as three reports', () => {
    expect(citizenReportViolation([report('a'), report('a')], report('b'))).toEqual([]);
    expect(citizenReportViolation([report('a', ['MEDICAL'], now + 1), report('b')], report('c'))).toEqual([]);
  });
  it.each([null, {}, {version:2,reports:[]}, {version:1,reports:[report('a'),report('b'),report('c')]},
    {version:1,reports:[report('a',['INVALID' as ResponseService])]}, {version:1,reports:[report('a',['FIRE','FIRE'])]}])('rejects corrupt persisted sequence state without disabling enforcement', metadata => {
    expect(() => readCitizenReportSequence(metadata)).toThrow('INVALID_CITIZEN_REPORT_SEQUENCE');
  });
});

function transactionFixture() {
  let previous: { metadata: unknown; createdAt: Date } | null = null;
  const auditLog = {
    findFirst: vi.fn(async () => previous),
    create: vi.fn(async ({ data }) => { if (data.action === CITIZEN_REPORT_SEQUENCE_ACTION) previous = { metadata: data.metadata, createdAt: data.createdAt }; }),
  };
  const mock = { auditLog, user: { updateMany: vi.fn(async () => ({count:1})) },
    token: { updateMany: vi.fn() }, responder: { updateMany: vi.fn() } };
  return { mock, tx: mock as unknown as Prisma.TransactionClient };
}
describe('durable serialized citizen restriction and reset', () => {
  it('persists a bounded last-two receipt, revokes all sessions once and audits the third', async () => {
    const { tx, mock } = transactionFixture();
    for (const id of ['a','b']) expect(await recordCitizenReportSequence(tx,'citizen',report(id))).toBe(false);
    expect(await recordCitizenReportSequence(tx,'citizen',report('c'))).toBe(true);
    expect(mock.user.updateMany).toHaveBeenCalledOnce();
    expect(mock.user.updateMany).toHaveBeenCalledWith({ where: {id:'citizen',role:'USER',status:'ACTIVE'},data:{status:'INACTIVE'} });
    expect(mock.token.updateMany).toHaveBeenCalledWith({where:{userId:'citizen',revokedAt:null},data:{revokedAt:expect.any(Date)}});
    const state = mock.auditLog.create.mock.calls.filter(([arg]) => arg.data.action === CITIZEN_REPORT_SEQUENCE_ACTION);
    expect(state[2][0].data.metadata.reports.map((row: {incidentId:string}) => row.incidentId)).toEqual(['b','c']);
    expect(state[1][0].data.createdAt.getTime()).toBeGreaterThan(state[0][0].data.createdAt.getTime());
    expect(mock.auditLog.create).toHaveBeenCalledWith({data:expect.objectContaining({action:'CITIZEN_AUTO_DEACTIVATED',metadata:expect.objectContaining({services:['MEDICAL'],incidentIds:['a','b','c']})})});
  });
  it('Main-admin reset preserves actor attribution and starts a genuinely fresh sequence', async () => {
    const { tx, mock } = transactionFixture();
    await recordCitizenReportSequence(tx,'citizen',report('a'));
    await recordCitizenReportSequence(tx,'citizen',report('b'));
    await resetCitizenReportSequence(tx,'citizen','main','REACTIVATED');
    expect(mock.auditLog.create).toHaveBeenCalledWith({data:expect.objectContaining({actorId:'main',metadata:{version:1,reports:[],resetReason:'REACTIVATED'}})});
    expect(await recordCitizenReportSequence(tx,'citizen',report('c'))).toBe(false);
    expect(await recordCitizenReportSequence(tx,'citizen',report('d'))).toBe(false);
    expect(await recordCitizenReportSequence(tx,'citizen',report('e'))).toBe(true);
  });
  it('refuses a lost role/status claim so the caller transaction rolls back', async () => {
    const { tx, mock } = transactionFixture();
    await recordCitizenReportSequence(tx,'citizen',report('a'));
    await recordCitizenReportSequence(tx,'citizen',report('b'));
    mock.user.updateMany.mockResolvedValue({count:0});
    await expect(recordCitizenReportSequence(tx,'citizen',report('c'))).rejects.toThrow('Account permissions changed');
    expect(mock.token.updateMany).not.toHaveBeenCalled();
  });
});
