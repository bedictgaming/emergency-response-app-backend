import type { Prisma } from '@/generated/prisma';
export function responderIncidentScope(userId: string): Prisma.IncidentWhereInput {
  return { OR: [
    { reportedBy: userId },
    { tasks: { some: { assignee: { userId } } } },
    { incidentUnits: { some: { unit: { responders: { some: { userId } } } } } },
  ] };
}
