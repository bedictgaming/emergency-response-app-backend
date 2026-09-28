import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { AnalyticsRepository } from "@/repositories/analytics.repository";
import { AlertRepository } from "@/repositories/alert.repository";
import { nearbyIncidentCandidateQuery } from "@/lib/incident-proximity";
import { randomUUID } from "node:crypto";

describe.runIf(process.env.RUN_DATABASE_TESTS === "1")("database integration", () => {
  it("connects and exposes the security and workflow migration", async () => {
    const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name::text, column_name::text
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('User', 'department'),
          ('User', 'is_main_admin'),
          ('incidents', 'verification_status'),
          ('incidents', 'merged_into_id'),
          ('incident_service_responses', 'status'),
          ('notification_outbox', 'status'),
          ('asset_cleanup_jobs', 'status')
        )
    `;
    expect(columns).toHaveLength(7);
  });

  it("executes the session-bound authentication lookup against PostgreSQL", async () => {
    const user = await prisma.user.findFirst({ select: { id: true } });
    const account = await prisma.user.findUnique({
      where: { id: user?.id ?? randomUUID() },
      select: {
        id: true,
        role: true,
        status: true,
        department: true,
        isMainAdmin: true,
        tokens: {
          where: {
            id: randomUUID(),
            type: "REFRESH",
            consumedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
          take: 1,
        },
      },
    });

    expect(account?.tokens ?? []).toEqual([]);
  });

  it("executes the grouped dashboard analytics against PostgreSQL", async () => {
    const result = await new AnalyticsRepository().getDashboardAnalytics();
    expect(result.incidentsByBarangay.totalIncidents).toBeGreaterThanOrEqual(0);
    expect(result.incidentsByType.totalIncidents).toBeGreaterThanOrEqual(0);
    expect(result.resolvedSummary.totalHistorical).toBeGreaterThanOrEqual(0);
  });

  it("reads the bounded public alert feed from PostgreSQL", async () => {
    const alerts = await new AlertRepository().findAll();
    expect(alerts.length).toBeLessThanOrEqual(50);
    for (const alert of alerts) {
      expect(Object.keys(alert).sort()).toEqual(["alertId", "alertType", "message", "sentAt", "severity"].sort());
    }
  });

  it("executes the bounded nearby-incident candidate query against PostgreSQL", async () => {
    const query = nearbyIncidentCandidateQuery(10.255, 123.967);
    const candidates = await prisma.incident.findMany(query);
    expect(Array.isArray(candidates)).toBe(true);
    for (const incident of candidates) {
      expect(["OPEN", "ACTIVE", "RESPONDING"]).toContain(incident.status);
      expect(Number(incident.latitude)).toBeGreaterThanOrEqual(query.where.latitude.gte);
      expect(Number(incident.latitude)).toBeLessThanOrEqual(query.where.latitude.lte);
    }
  });
});
