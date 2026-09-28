import { AlertRepository } from "@/repositories/alert.repository";
import { CreateAlertInput } from "@/schema/alert/create-alert.schema";
import { prisma } from "@/lib/prisma";
import { publishEmergencyEvent } from "@/lib/events";
import { enqueueNotification } from "@/lib/jobs";

const alertRepository = new AlertRepository();

export const CreateAlertService = async (
  data: CreateAlertInput,
  sentBy: string
) => {
  try {
    // 1. If incidentId provided, verify incident exists
    if (data.incidentId) {
      const incident = await alertRepository.findIncidentById(data.incidentId);
      if (!incident) {
        return {
          code: 404,
          status: "error",
          message: "Linked incident not found. Please provide a valid incidentId.",
        };
      }
      if (incident.verificationStatus !== "VERIFIED") {
        return { code: 409, status: "error", message: "Only verified incidents can be broadcast" };
      }
    }

    // 2. If locationId provided, verify location exists
    if (data.locationId) {
      const location = await alertRepository.findLocationById(data.locationId);
      if (!location) {
        return {
          code: 404,
          status: "error",
          message: "Linked location not found. Please provide a valid locationId.",
        };
      }
    }

    const alert = await prisma.$transaction(async (tx) => {
      const created = await tx.alert.create({
        data: { ...data, sentBy },
        include: { sender: { select: { id: true, name: true, email: true, role: true } }, incident: { select: { incidentId: true, title: true, status: true } }, location: { select: { locationId: true, locationName: true } } },
      });
      await tx.auditLog.create({ data: { actorId: sentBy, action: "ALERT_CREATED", entityType: "Alert", entityId: created.alertId } });
      const recipients = await tx.user.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
      await enqueueNotification(tx, "ALERT_CREATED", {
        title: `Emergency alert: ${created.alertType.replaceAll("_", " ")}`,
        body: created.message,
        data: { alertId: created.alertId, type: "alert" },
      }, recipients.map(({ id }) => id));
      return created;
    });
    publishEmergencyEvent({ type: "alert.created", entityId: alert.alertId });

    return {
      code: 201,
      status: "success",
      message: "Alert broadcast dispatched successfully",
      data: { alert },
    };
  } catch (error) {
    console.error("CreateAlertService Error", error);
    return { code: 500, status: "error", message: "Failed to dispatch alert" };
  }
};
