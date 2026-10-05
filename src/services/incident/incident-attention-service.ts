import { Department, Prisma, ResponseService } from '@/generated/prisma';
import { prisma } from '@/lib/prisma';
import type { JwtPayload } from '@/lib/jwt';
import { departmentIncidentScope, departmentService } from '@/lib/department-access';
import { isMainAdministrator } from '@/lib/permissions';
import { publishEmergencyEvent } from '@/lib/events';

export function attentionScope(actor: JwtPayload, requested?: ResponseService) {
  if (!['ADMIN', 'DISPATCHER'].includes(actor.role)) return null;
  if (isMainAdministrator(actor)) return requested ?? 'MAIN';
  const service = departmentService(actor.department);
  return service && (!requested || requested === service) ? service : null;
}

export function attentionVersion(incident: { status: string; verificationStatus: string; mergedIntoId?: string | null;
  attentionVersion: number; serviceResponses: Array<{ service: string; status: string; attentionVersion: number }> }, scope: string) {
  if (incident.verificationStatus !== 'VERIFIED' || incident.mergedIntoId || !['OPEN', 'ACTIVE', 'RESPONDING'].includes(incident.status)) return null;
  if (scope === 'MAIN') return incident.attentionVersion;
  const response = incident.serviceResponses.find(item => item.service === scope);
  return response ? response.status === 'RESPONDING' ? response.attentionVersion : null : incident.attentionVersion;
}

// Recheck identity in the same transaction; middleware's earlier actor is not
// authority for a role change racing an acknowledgement.
async function currentActor(tx: Prisma.TransactionClient, actor: JwtPayload) {
  const user = await tx.user.findUnique({ where: { id: actor.sub }, select: {
    role: true, status: true, department: true, isMainAdmin: true,
    tokens: { where: { id: actor.sessionId ?? '', type: 'REFRESH', revokedAt: null, consumedAt: null, expiresAt: { gt: new Date() } }, take: 1, select: { id: true } },
  } });
  return user?.status === 'ACTIVE' && user.tokens.length ? { ...actor, ...user } : null;
}

export async function listIncidentAttention(actor: JwtPayload, requested?: ResponseService) {
  return prisma.$transaction(async tx => {
    const fresh = await currentActor(tx, actor);
    const scope = fresh && attentionScope(fresh, requested);
    if (!fresh || !scope) return null;
    const service = scope === 'MAIN' ? Prisma.sql`TRUE` : Prisma.sql`(
      ((s.status IS NULL OR s.status = 'RESPONDING') AND ${scope}::"ResponseService" = ANY(i.requested_services)) OR
      (cardinality(i.requested_services) = 0 AND LOWER(t.type_name) LIKE ${`%${scope.toLowerCase()}%`} AND (s.status IS NULL OR s.status = 'RESPONDING'))
    )`;
    const version = scope === 'MAIN' ? Prisma.sql`i.attention_version` : Prisma.sql`COALESCE(s.attention_version, i.attention_version)`;
    const ids = await tx.$queryRaw<Array<{ incidentId: string; version: number }>>(Prisma.sql`
      SELECT i.incident_id AS "incidentId", ${version} AS version FROM incidents i
      JOIN incident_types t ON t.type_id = i.type_id
      LEFT JOIN incident_service_responses s ON s.incident_id = i.incident_id AND s.service = ${scope === 'MAIN' ? 'FIRE' : scope}::"ResponseService"
      WHERE i.verification_status = 'VERIFIED' AND i.status IN ('OPEN','ACTIVE','RESPONDING') AND i.merged_into_id IS NULL
        AND ${service}
        AND NOT EXISTS (SELECT 1 FROM incident_acknowledgements a WHERE a.user_id = ${actor.sub}
          AND a.incident_id = i.incident_id AND a.scope = ${scope} AND a.version = ${version})
      ORDER BY i.reported_at ASC, i.incident_id ASC LIMIT 51
    `);
    const page = ids.slice(0, 50);
    const rows = await tx.incident.findMany({ where: { incidentId: { in: page.map(item => item.incidentId) } }, select: {
      incidentId: true, title: true, description: true, reportedAt: true, status: true, verificationStatus: true,
      type: { select: { typeName: true } }, location: { select: { locationName: true, address: true } },
      reporter: { select: { name: true } },
    } });
    const byId = new Map(rows.map(item => [item.incidentId, item]));
    return { scope, hasMore: ids.length > 50, items: page.map(item => ({ ...byId.get(item.incidentId)!, version: item.version, scope })) };
  }, { isolationLevel: 'RepeatableRead' });
}

export async function acknowledgeIncidentAttention(actor: JwtPayload, incidentId: string, version: number, requested?: ResponseService) {
  const result = await prisma.$transaction(async tx => {
    // Lock actor first, then incident, matching account-change lock ordering.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.sub} FOR UPDATE`;
    const fresh = await currentActor(tx, actor);
    const scope = fresh && attentionScope(fresh, requested);
    if (!fresh || !scope) return 403;
    await tx.$queryRaw`SELECT incident_id FROM incidents WHERE incident_id = ${incidentId}::uuid FOR UPDATE`;
    const incident = await tx.incident.findFirst({ where: { incidentId, ...(scope !== 'MAIN' && departmentIncidentScope({ ...fresh, department: scope === 'HAZARD' ? 'DRRMO' : scope as Department, isMainAdmin: false })) }, include: { serviceResponses: true } });
    if (!incident) return 404;
    if (attentionVersion(incident, scope) !== version) return 409;
    const existing = await tx.incidentAcknowledgement.findUnique({ where: { userId_incidentId_scope: { userId: actor.sub, incidentId, scope } } });
    if (existing?.version === version) return 200;
    await tx.incidentAcknowledgement.upsert({ where: { userId_incidentId_scope: { userId: actor.sub, incidentId, scope } },
      create: { userId: actor.sub, incidentId, scope, version }, update: { version, createdAt: new Date() } });
    await tx.auditLog.create({ data: { actorId: actor.sub, action: 'INCIDENT_ATTENTION_ACKNOWLEDGED', entityType: 'Incident', entityId: incidentId, metadata: { scope, version } } });
    return 200;
  });
  if (result === 200) publishEmergencyEvent({ type: 'incident.updated', entityId: incidentId });
  return result;
}
