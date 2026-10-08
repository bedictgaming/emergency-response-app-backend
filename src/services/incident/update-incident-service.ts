import { IncidentRepository } from "@/repositories/incident.repository";
import { UpdateIncidentInput } from "@/schema/incident/update-incident.schema";
import { publishEmergencyEvent } from "@/lib/events";
import { prisma } from "@/lib/prisma";
import { isWorkflowConflict } from "@/lib/workflow-error";
import { protectIncidentEvidence } from "@/lib/evidence";

const incidentRepository = new IncidentRepository();

// Valid status transition map
const VALID_TRANSITIONS: Record<string, string[]> = {
  OPEN: ["ACTIVE"],
  ACTIVE: [],
  RESPONDING: [],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
};

export const UpdateIncidentService = async (
  id: string,
  data: UpdateIncidentInput,
  actorId?: string,
) => {
  // Overall completion belongs exclusively to the department-response workflow.
  // Reject even direct/internal calls, not only the removed dashboard control.
  if (data.status === "RESOLVED") {
    return { code: 403, status: "error", message: "Only the assigned departments can resolve their responses. The incident resolves when all requested services finish." };
  }
  try {
    const existing = await incidentRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Incident not found" };
    }

    // Status buttons are safe to retry. Avoid touching updatedAt or creating a
    // duplicate audit entry when the requested status is already in place.
    if (data.status === existing.status && Object.keys(data).length === 1) {
      return {
        code: 200,
        status: "success",
        message: "Incident status was already up to date",
        data: { incident: protectIncidentEvidence(existing) },
      };
    }

    // Validate status transition if status is being changed
    if (data.status && data.status !== existing.status) {
      if (data.status === "ACTIVE" && existing.verificationStatus !== "VERIFIED") {
        return { code: 409, status: "error", message: "An incident must be verified before activation" };
      }
      const allowedNext = VALID_TRANSITIONS[existing.status] ?? [];
      if (!allowedNext.includes(data.status)) {
        return {
          code: 400,
          status: "error",
          message: `Invalid status transition: cannot move from "${existing.status}" to "${data.status}". Allowed: ${allowedNext.join(", ") || "none"}`,
        };
      }
    }

    // Category determines department ownership for legacy incidents. A plain
    // field update cannot safely transfer response rows, tasks and dispatches.
    if (data.typeId && data.typeId !== existing.typeId) {
      return { code: 409, status: "error", message: "Incident category cannot be changed through a general update" };
    }

    // Validate locationId if provided
    if (data.locationId) {
      const location = await incidentRepository.findLocationById(data.locationId);
      if (!location) {
        return {
          code: 404,
          status: "error",
          message: "Location not found. Please provide a valid locationId.",
        };
      }
    }

    const incident = await prisma.$transaction(async (tx) => {
      const updated = await tx.incident.update({
        where: { incidentId: id, status: existing.status, verificationStatus: existing.verificationStatus, updatedAt: existing.updatedAt },
        data,
        include: { type: true, location: true, barangay: true, attachments: true, serviceResponses: true },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: "INCIDENT_UPDATED",
          entityType: "Incident",
          entityId: id,
          metadata: { changes: data },
        },
      });
      return updated;
    });
    publishEmergencyEvent({ type: "incident.updated", entityId: id });

    return {
      code: 200,
      status: "success",
      message: "Incident updated successfully",
      data: { incident: protectIncidentEvidence(incident) },
    };
  } catch (error) {
    if (isWorkflowConflict(error)) {
      // Two operators (or a double click) may request the same transition at
      // once. If the winner already reached our target, this request succeeded
      // semantically and should not surface a false conflict to the operator.
      if (data.status && Object.keys(data).length === 1) {
        const current = await incidentRepository.findById(id);
        if (current?.status === data.status) {
          return {
            code: 200,
            status: "success",
            message: "Incident status was updated by another request",
            data: { incident: protectIncidentEvidence(current) },
          };
        }
      }
      return { code: 409, status: "error", message: "Incident changed concurrently. The latest record has been loaded; review it before retrying." };
    }
    console.error("UpdateIncidentService Error", error);
    return { code: 500, status: "error", message: "Failed to update incident" };
  }
};
