import { IncidentRepository } from "@/repositories/incident.repository";
import { protectIncidentEvidence } from "@/lib/evidence";
import type { Department } from "@/generated/prisma";

const incidentRepository = new IncidentRepository();

export const GetIncidentService = async (id: string, reviewDepartment?: Department | "ALL") => {
  try {
    const incident = await incidentRepository.findById(id, reviewDepartment);

    if (!incident) {
      return { code: 404, status: "error", message: "Incident not found" };
    }

    return {
      code: 200,
      status: "success",
      data: { incident: protectIncidentEvidence(incident) },
    };
  } catch (error) {
    console.error("GetIncidentService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch incident" };
  }
};
