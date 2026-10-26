import { prisma } from '@/lib/prisma';
import type { JwtPayload } from '@/lib/jwt';

/** Private in-app status feed, not public alerts, push delivery or staff audit export. */
export async function CitizenReviewNotifications(actor: JwtPayload) {
  if (actor.role !== 'USER' || actor.type !== 'access' || !actor.sessionId) return { code: 403, message: 'Citizen session required' };
  try {
    return await prisma.$transaction(async tx => {
      // Same User -> Token ordering as account/session changes. A revoked or
      // reassigned actor cannot use a formerly valid citizen request.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.sub} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Token" WHERE id = ${actor.sessionId!} AND "userId" = ${actor.sub} FOR UPDATE`;
      const now = new Date();
      const user = await tx.user.findUnique({ where: { id: actor.sub }, select: { role: true, status: true,
        tokens: { where: { id: actor.sessionId!, type: 'REFRESH', revokedAt: null, consumedAt: null, expiresAt: { gt: now } }, select: { id: true }, take: 1 } } });
      if (!user || user.role !== 'USER' || user.status !== 'ACTIVE' || user.tokens.length !== 1
        || (actor.exp !== undefined && actor.exp * 1000 <= now.getTime())) return { code: 403, message: 'Your citizen session changed. Log in again.' };
      const rows = await tx.incidentReviewFlag.findMany({ where: { incident: { reportedBy: actor.sub } },
        orderBy: [{ updatedAt: 'desc' }, { reviewFlagId: 'desc' }], take: 51,
        select: { reviewFlagId: true, department: true, status: true, updatedAt: true,
          incident: { select: { incidentId: true, title: true } } } });
      return { code: 200, data: { items: rows.slice(0, 50).map(row => ({
        id: row.reviewFlagId, incidentId: row.incident.incidentId, reportTitle: row.incident.title,
        department: row.department, status: row.status, updatedAt: row.updatedAt.toISOString(),
      })), limit: 50, hasMore: rows.length > 50 } };
    });
  } catch {
    return { code: 503, message: 'Report review notifications are unavailable. Try again; your reports are unchanged.' };
  }
}
