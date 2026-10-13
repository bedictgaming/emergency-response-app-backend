import { IncidentRepository } from "@/repositories/incident.repository";
import { protectIncidentEvidence } from "@/lib/evidence";
import type { Department } from "@/generated/prisma";
import { presentIncidentReviews, type ReviewNoticeScope } from '@/domain/incident-review-notices.policy';

const incidentRepository = new IncidentRepository();

export const GetIncidentService = async (id: string, reviewDepartment?: Department | "ALL", reviewNoticeDepartment?: ReviewNoticeScope) => {
  try {
    const incident = await incidentRepository.findById(id, reviewDepartment, reviewNoticeDepartment);

    if (!incident) {
      return { code: 404, status: "error", message: "Incident not found" };
    }

    return {
      code: 200,
      status: "success",
      data: { incident: protectIncidentEvidence(presentIncidentReviews(incident, reviewDepartment, reviewNoticeDepartment)) },
    };
  } catch (error) {
    console.error("GetIncidentService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch incident" };
  }
};
