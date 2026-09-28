import { IncidentRepository } from "@/repositories/incident.repository";
import { protectIncidentEvidence } from "@/lib/evidence";

const incidentRepository = new IncidentRepository();

export const GetIncidentService = async (id: string) => {
  try {
    const incident = await incidentRepository.findById(id);

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
