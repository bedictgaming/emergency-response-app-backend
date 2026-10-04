import { prisma } from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma';
import { isMainAdministrator } from '@/lib/permissions';

const managedUserSelect = {
  id: true, name: true, email: true, role: true, status: true,
  department: true, isMainAdmin: true, updatedAt: true,
  responder: { select: { responderId: true } },
} as const;
export type ManagedUser = Prisma.UserGetPayload<{ select: typeof managedUserSelect }>;

export class UserAdministrationError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

/** Serialize assignment/status changes and recheck authority after acquiring locks. */
export async function withUserAdministration<T>(
  id: string,
  actorId: string | undefined,
  mutate: (tx: Prisma.TransactionClient, existing: ManagedUser) => Promise<T>,
): Promise<T> {
  if (!actorId) throw new UserAdministrationError(403, 'Main administrator access required');
  return prisma.$transaction(async tx => {
    // Shared with the one-time bootstrap; user-management mutations use this order.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('main-admin-bootstrap'))::text AS lock_token`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id IN (${actorId}, ${id}) ORDER BY id FOR UPDATE`;
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: managedUserSelect });
    if (!actor || actor.status !== 'ACTIVE' || !isMainAdministrator(actor)) {
      throw new UserAdministrationError(403, 'Main administrator access required');
    }
    const existing = id === actorId ? actor : await tx.user.findUnique({ where: { id }, select: managedUserSelect });
    if (!existing) throw new UserAdministrationError(404, 'User not found');
    return mutate(tx, existing);
  });
}

export async function ensureMainAdministratorRemains(
  tx: Prisma.TransactionClient,
  existing: ManagedUser,
  next: Pick<ManagedUser, 'role' | 'status' | 'department' | 'isMainAdmin'>,
) {
  if (existing.status !== 'ACTIVE' || !isMainAdministrator(existing)
      || (next.status === 'ACTIVE' && isMainAdministrator(next))) return;
  const others = await tx.user.count({ where: {
    id: { not: existing.id }, role: 'ADMIN', status: 'ACTIVE', department: 'MAIN', isMainAdmin: true,
  } });
  if (others === 0) throw new UserAdministrationError(409, 'At least one active main administrator must remain');
}

export function userAdministrationFailure(error: unknown, fallback: string) {
  if (error instanceof UserAdministrationError) return { code: error.code, status: 'error', message: error.message };
  if ((error as { code?: string })?.code === 'P2034') {
    return { code: 409, status: 'error', message: 'Account permissions changed concurrently. Refresh and try again.' };
  }
  // Never log raw database errors, user rows, credentials or provider URLs.
  console.warn('User administration transaction failed');
  return { code: 500, status: 'error', message: fallback };
}
