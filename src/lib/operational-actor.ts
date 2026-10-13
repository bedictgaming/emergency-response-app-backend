import type { Prisma } from '@/generated/prisma';
import type { JwtPayload } from '@/lib/jwt';
import { hasValidOperationalAssignment, permissionsForActor } from '@/domain/permissions.policy';

export class OperationalAuthorizationError extends Error {
  readonly code = 403;
  constructor() { super('Your session or administrator permissions changed. Refresh or log in again.'); }
}

/** User -> session -> incident is the mutation lock order. Never call after locking an incident. */
export async function lockOperationalActor(tx: Prisma.TransactionClient, actor: JwtPayload): Promise<JwtPayload> {
  if (!actor.sessionId || actor.type !== 'access') throw new OperationalAuthorizationError();
  // Account administration, refresh and password reset also lock User first.
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.sub} FOR UPDATE`;
  // Logout updates Token directly; this lock also serializes session revocation.
  await tx.$queryRaw`SELECT id FROM "Token" WHERE id = ${actor.sessionId} AND "userId" = ${actor.sub} FOR UPDATE`;
  const now = new Date();
  const user = await tx.user.findUnique({ where: { id: actor.sub }, select: {
    role: true, status: true, department: true, isMainAdmin: true,
    tokens: { where: { id: actor.sessionId, type: 'REFRESH', revokedAt: null, consumedAt: null, expiresAt: { gt: now } }, select: { id: true }, take: 1 },
  } });
  if (!user || user.status !== 'ACTIVE' || user.tokens.length !== 1
      || !['ADMIN', 'DISPATCHER'].includes(user.role) || !hasValidOperationalAssignment(user)
      || user.role !== actor.role || user.department !== actor.department
      || user.isMainAdmin !== (actor.isMainAdmin ?? false)
      || (actor.exp !== undefined && actor.exp * 1000 <= now.getTime())) throw new OperationalAuthorizationError();
  return { ...actor, role: user.role, department: user.department, isMainAdmin: user.isMainAdmin, permissions: permissionsForActor(user) };
}
