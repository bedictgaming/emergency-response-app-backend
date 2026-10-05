import type { Prisma, ResponseService } from '@/generated/prisma';
import { unitTypeSupportsService } from '@/lib/response-services';
export async function incidentNotificationAudience(tx: Prisma.TransactionClient, services: ResponseService[]) {
  const [staff, responders] = await Promise.all([
    tx.user.findMany({ where: { status: 'ACTIVE', role: { in: ['ADMIN','DISPATCHER'] }, OR: [
      { role: 'ADMIN', department: 'MAIN', isMainAdmin: true },
      { department: { in: services.map(service => service === 'HAZARD' ? 'DRRMO' : service) } },
    ] }, select: { id: true } }),
    tx.responder.findMany({ where: { status: { not: 'OFF_DUTY' }, user: { status: 'ACTIVE', role: 'RESPONDER' } }, select: { userId: true, unit: { select: { unitType: true } } } }),
  ]);
  return [...new Set([...staff.map(item => item.id), ...responders.filter(item => unitTypeSupportsService(item.unit.unitType, services)).map(item => item.userId)])];
}
