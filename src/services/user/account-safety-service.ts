import crypto from 'node:crypto';
import type { JwtPayload } from '@/lib/jwt';
import { withUserAdministration, UserAdministrationError, userAdministrationFailure } from '@/lib/user-administration';
import { lockOperationalActor, OperationalAuthorizationError } from '@/lib/operational-actor';
import { confirmedFalseSummary } from '@/lib/confirmed-false-sanctions';
import { passwordResetMail } from '@/services/auth/password-reset-service';
import { sendEmail } from '@/services/mail/mailer';
import { recentReportRequestContexts } from '@/lib/report-request-context';

export async function UserViolationSummary(id: string, actor: JwtPayload) {
  try {
    return await withUserAdministration(id, actor.sub, async (tx) => {
      await lockOperationalActor(tx, actor);
      const summary = await confirmedFalseSummary(tx, id);
      const events = await tx.auditLog.findMany({ where: { entityType: 'User', entityId: id, action: {
        in: ['CITIZEN_FALSE_REPORT_DECISION', 'CITIZEN_FALSE_REPORT_RESET', 'CITIZEN_AUTO_DEACTIVATED'],
      } }, orderBy: [{ createdAt: 'desc' }, { auditLogId: 'desc' }], take: 20,
      select: { action: true, metadata: true, createdAt: true } });
      const reports = await tx.auditLog.findMany({ where: { actorId: id, entityType: 'Incident',
        action: { in: ['INCIDENT_CREATED', 'INCIDENT_DUPLICATE_OVERRIDE'] } }, orderBy: [{ createdAt: 'desc' }, { auditLogId: 'desc' }], take: 20,
        select: { auditLogId: true, entityId: true, createdAt: true } });
      const contexts = await recentReportRequestContexts(tx, reports.map(report => report.auditLogId));
      return { code: 200, data: { ...summary, events, recentReports: reports.map(report => ({
        incidentId: report.entityId, createdAt: report.createdAt,
        ipAddress: contexts.get(report.auditLogId)?.ipAddress ?? null,
        userAgent: contexts.get(report.auditLogId)?.userAgent ?? null,
      })) } };
    });
  } catch (error) {
    if (error instanceof OperationalAuthorizationError) return { code: error.code, message: error.message };
    return userAdministrationFailure(error, 'Could not load the account violation record');
  }
}

/** Main initiates owner-controlled recovery, never chooses or sees a replacement password/token. */
export async function AdminRequestPasswordReset(id: string, actor: JwtPayload) {
  try {
    const mail = await withUserAdministration(id, actor.sub, async (tx, user) => {
      await lockOperationalActor(tx, actor);
      if (user.status !== 'ACTIVE' || !user.email) throw new UserAdministrationError(409, 'An active account with an email address is required. This action does not reactivate accounts.');
      const now = Date.now();
      const recent = await tx.token.count({ where: { userId: id, type: 'PASSWORD_RESET', createdAt: { gt: new Date(now - 60_000) } } });
      const hourly = await tx.auditLog.count({ where: { actorId: actor.sub, action: 'ADMIN_PASSWORD_RESET_REQUESTED', createdAt: { gt: new Date(now - 3_600_000) } } });
      const targetHourly = await tx.token.count({ where: { userId: id, type: 'PASSWORD_RESET', createdAt: { gt: new Date(now - 3_600_000) } } });
      if (recent || hourly >= 20 || targetHourly >= 5) throw new UserAdministrationError(429, 'Reset request limit reached. Wait before trying again.');
      const token = crypto.randomBytes(32).toString('hex'), expiresAt = new Date(now + 30 * 60_000);
      await tx.token.create({ data: { userId: id, type: 'PASSWORD_RESET', token: crypto.createHash('sha256').update(token).digest('hex'), expiresAt } });
      await tx.auditLog.create({ data: { actorId: actor.sub, action: 'ADMIN_PASSWORD_RESET_REQUESTED', entityType: 'User', entityId: id } });
      return passwordResetMail({ email: user.email, name: user.name }, token, expiresAt);
    });
    try { await sendEmail(mail); }
    catch { return { code: 503, message: 'Reset email delivery was not confirmed. No password was changed. Wait a minute before requesting another link.' }; }
    return { code: 202, message: 'Reset email accepted for delivery to the account owner. The link expires in 30 minutes; delivery and account recovery are not yet confirmed.' };
  } catch (error) {
    if (error instanceof OperationalAuthorizationError) return { code: error.code, message: error.message };
    return userAdministrationFailure(error, 'Password reset could not be requested');
  }
}
