import { prisma } from "@/lib/prisma";
import { IncidentStatus, Prisma, VerificationStatus } from "@/generated/prisma";
import { getCurrentManilaMonth, getManilaMonthRange } from "@/lib/manila-calendar";

export interface IncidentsByBarangayFilters {
  from?: Date;
  to?: Date;
  typeId?: string;
  scope?: Prisma.IncidentWhereInput;
}

export interface IncidentsByTypeFilters {
  from?: Date;
  to?: Date;
  barangayId?: string;
  scope?: Prisma.IncidentWhereInput;
}

export interface ResolvedSummaryFilters {
  month?: number; // 1-12
  year?: number;
  barangayId?: string;
  scope?: Prisma.IncidentWhereInput;
}

export class AnalyticsRepository {
  /**
   * Question 1: "Which areas have frequent emergency reports?"
   * Returns all 13 barangays with their incident counts, percentages, and active/resolved breakdown.
   */
  async getIncidentsByBarangay(filters?: IncidentsByBarangayFilters) {
    const [barangays, counts] = await Promise.all([
      prisma.barangay.findMany({ orderBy: { name: "asc" }, select: { barangayId: true, name: true, status: true } }),
      prisma.incident.groupBy({
        by: ["barangayId", "status"],
        where: {
          verificationStatus: VerificationStatus.VERIFIED,
          AND: [filters?.scope ?? {}],
          ...((filters?.from || filters?.to) && {
            reportedAt: { ...(filters?.from && { gte: filters.from }), ...(filters?.to && { lte: filters.to }) },
          }),
          ...(filters?.typeId && { typeId: filters.typeId }),
        },
        _count: { _all: true },
      }),
    ]);
    const byBarangay = new Map<string, { count: number; active: number; responding: number; resolved: number }>();
    for (const row of counts) {
      const key = row.barangayId ?? "UNSPECIFIED";
      const item = byBarangay.get(key) ?? { count: 0, active: 0, responding: 0, resolved: 0 };
      item.count += row._count._all;
      if (row.status === IncidentStatus.ACTIVE || row.status === IncidentStatus.OPEN) item.active += row._count._all;
      if (row.status === IncidentStatus.RESPONDING) item.responding += row._count._all;
      if (row.status === IncidentStatus.RESOLVED || row.status === IncidentStatus.CLOSED) item.resolved += row._count._all;
      byBarangay.set(key, item);
    }
    const totalIncidents = Array.from(byBarangay.values()).reduce((total, item) => total + item.count, 0);

    const rankings = [...barangays, ...(byBarangay.has("UNSPECIFIED") ? [{ barangayId: "UNSPECIFIED", name: "Barangay unavailable", status: "INACTIVE" }] : [])]
      .map((b) => {
        const grouped = byBarangay.get(b.barangayId);
        const count = grouped?.count ?? 0;
        const activeCount = grouped?.active ?? 0;
        const resolvedCount = grouped?.resolved ?? 0;
        const percentage = totalIncidents > 0 ? Math.round((count / totalIncidents) * 100) : 0;

        let riskLevel: "HIGH" | "MODERATE" | "LOW" = "LOW";
        if (percentage >= 30 || count >= 10) riskLevel = "HIGH";
        else if (percentage >= 15 || count >= 5) riskLevel = "MODERATE";

        return {
          barangayId: b.barangayId,
          name: b.name,
          status: b.status,
          incidentCount: count,
          activeCount,
          respondingCount: grouped?.responding ?? 0,
          resolvedCount,
          percentage,
          riskLevel,
        };
      })
      .sort((a, b) => b.incidentCount - a.incidentCount);

    return {
      totalIncidents,
      topArea: rankings[0] || null,
      rankings,
    };
  }

  /**
   * Question 2: "What type of emergency happens most often?"
   * Returns incident distribution by category with percentage share.
   */
  async getIncidentsByType(filters?: IncidentsByTypeFilters) {
    const [incidentTypes, counts] = await Promise.all([
      prisma.incidentType.findMany({ orderBy: { typeName: "asc" }, select: { typeId: true, typeName: true, description: true } }),
      prisma.incident.groupBy({
        by: ["typeId"],
        where: {
          verificationStatus: VerificationStatus.VERIFIED,
          AND: [filters?.scope ?? {}],
          ...((filters?.from || filters?.to) && {
            reportedAt: { ...(filters?.from && { gte: filters.from }), ...(filters?.to && { lte: filters.to }) },
          }),
          ...(filters?.barangayId && { barangayId: filters.barangayId }),
        },
        _count: { _all: true },
      }),
    ]);
    const countByType = new Map(counts.map(row => [row.typeId, row._count._all]));
    const total = counts.reduce((sum, row) => sum + row._count._all, 0);

    const typeColors: Record<string, string> = {
      "Fire Outbreak": "#ef4444",
      "Medical Emergency": "#ec4899",
      "Police & Security": "#3b82f6",
      "Natural Hazard & Flood": "#f59e0b",
    };

    const distribution = incidentTypes
      .map((t) => {
        const count = countByType.get(t.typeId) ?? 0;
        const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
        const color = typeColors[t.typeName] || "#8b5cf6";

        return {
          typeId: t.typeId,
          typeName: t.typeName,
          description: t.description,
          count,
          percentage,
          color,
        };
      })
      .sort((a, b) => b.count - a.count);

    return {
      totalIncidents: total,
      topType: distribution[0] || null,
      distribution,
    };
  }

  /**
   * Question 3: "How many incidents were resolved this month?"
   * Computes monthly resolution metrics for a given calendar month/year.
   */
  async getResolvedSummary(filters?: ResolvedSummaryFilters) {
    const currentManilaMonth = getCurrentManilaMonth();
    const targetMonth = filters?.month ?? currentManilaMonth.month;
    const targetYear = filters?.year ?? currentManilaMonth.year;
    const { start: startOfMonth, end: startOfNextMonth } = getManilaMonthRange(targetMonth, targetYear);

    const commonWhere: Prisma.IncidentWhereInput = {
      verificationStatus: VerificationStatus.VERIFIED,
      AND: [filters?.scope ?? {}],
      ...(filters?.barangayId && { barangayId: filters.barangayId }),
    };
    const [monthly, historical] = await Promise.all([
      prisma.incident.groupBy({
        by: ["status"],
        where: { ...commonWhere, reportedAt: { gte: startOfMonth, lt: startOfNextMonth } },
        _count: { _all: true },
      }),
      prisma.incident.groupBy({ by: ["status"], where: commonWhere, _count: { _all: true } }),
    ]);

    const totalReportedThisMonth = monthly.reduce((sum, row) => sum + row._count._all, 0);
    const resolvedThisMonth = monthly.reduce((sum, row) =>
      sum + (row.status === IncidentStatus.RESOLVED || row.status === IncidentStatus.CLOSED ? row._count._all : 0), 0);
    const activeThisMonth = totalReportedThisMonth - resolvedThisMonth;

    const resolutionRate =
      totalReportedThisMonth > 0
        ? Math.round((resolvedThisMonth / totalReportedThisMonth) * 100)
        : 0;

    const totalHistorical = historical.reduce((sum, row) => sum + row._count._all, 0);
    const totalResolvedAllTime = historical.reduce((sum, row) =>
      sum + (row.status === IncidentStatus.RESOLVED || row.status === IncidentStatus.CLOSED ? row._count._all : 0), 0);

    return {
      month: targetMonth,
      year: targetYear,
      totalReportedThisMonth,
      resolvedThisMonth,
      activeThisMonth,
      resolutionRate,
      totalHistorical,
      totalResolvedAllTime,
    };
  }

  /**
   * Combined Dashboard payload aggregating all three answers in a single performant call.
   */
  async getDashboardAnalytics(scope?: Prisma.IncidentWhereInput) {
    const [incidentsByBarangay, incidentsByType, resolvedSummary] = await Promise.all([
      this.getIncidentsByBarangay({ scope }),
      this.getIncidentsByType({ scope }),
      this.getResolvedSummary({ scope }),
    ]);

    return {
      incidentsByBarangay,
      incidentsByType,
      resolvedSummary,
    };
  }
}
