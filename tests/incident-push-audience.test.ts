import { expect, it, vi } from 'vitest';
import { incidentNotificationAudience } from '@/lib/incident-notification-audience';
import type { Prisma } from '@/generated/prisma';

it.each([['FIRE', 'FIRE'], ['MEDICAL', 'MEDICAL'], ['POLICE', 'POLICE'], ['HAZARD', 'DRRMO']] as const)(
  'creation targets Main Admin plus the assigned %s service, without unrelated departments', async (service, department) => {
    const staff = vi.fn().mockResolvedValue([{ id: 'main' }, { id: 'assigned' }]);
    const responders = vi.fn().mockResolvedValue([]);
    const tx = { user: { findMany: staff }, responder: { findMany: responders } } as unknown as Prisma.TransactionClient;
    expect(await incidentNotificationAudience(tx, [service])).toEqual(['main', 'assigned']);
    expect(staff).toHaveBeenCalledWith({ where: { status: 'ACTIVE', role: { in: ['ADMIN', 'DISPATCHER'] }, OR: [
      { role: 'ADMIN', department: 'MAIN', isMainAdmin: true }, { department: { in: [department] } },
    ] }, select: { id: true } });
  },
);
