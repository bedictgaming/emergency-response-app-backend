import { IncidentRepository } from "@/repositories/incident.repository";
import { protectIncidentEvidence } from "@/lib/evidence";
import type { Department, Prisma } from "@/generated/prisma";
import { withNearbyReportNotices } from './nearby-report-notices';
import { presentIncidentReviews, type ReviewNoticeScope } from '@/domain/incident-review-notices.policy';
import { nearbyIntakeSummary } from '@/lib/nearby-review';
import { prisma } from '@/lib/prisma';

const incidentRepository = new IncidentRepository();

export const GetIncidentService = async (id: string, reviewDepartment?: Department | "ALL", reviewNoticeDepartment?: ReviewNoticeScope, nearbyWarningScope?: Prisma.IncidentWhereInput) => {
  try {
    const incident = await incidentRepository.findById(id, reviewDepartment, reviewNoticeDepartment);

    if (!incident) {
      return { code: 404, status: "error", message: "Incident not found" };
    }

    const presented = nearbyWarningScope ? (await withNearbyReportNotices([incident], nearbyWarningScope))[0] : incident;
    const intake = await nearbyIntakeSummary(prisma, [id]);
    return {
      code: 200,
      status: "success",
      data: { incident: { ...protectIncidentEvidence(presentIncidentReviews(presented, reviewDepartment, reviewNoticeDepartment)),
        ...(intake.length && { nearbyIntake: intake.map(row => ({ service: row.service, status: row.status,
          ...('responseStarted' in row && { responseStarted: row.responseStarted }) })) }),
      } },
    };
  } catch (error) {
    console.error("GetIncidentService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch incident" };
  }
};
