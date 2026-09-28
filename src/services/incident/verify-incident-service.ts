import { prisma } from "@/lib/prisma";
import { VerificationStatus } from "@/generated/prisma";
import { VerifyIncidentInput } from "@/schema/incident/verify-incident.schema";
import { publishEmergencyEvent } from "@/lib/events";
import { enqueueNotification } from "@/lib/jobs";
import { protectIncidentEvidence } from "@/lib/evidence";

export async function VerifyIncidentService(
  incidentId: string,
  input: VerifyIncidentInput,
  actorId: string,
  ipAddress?: string,
) {
  const existing = await prisma.incident.findUnique({
    where: { incidentId },
    select: { incidentId: true, title: true, reportedBy: true, verificationStatus: true },
  });
  if (!existing) return { code: 404, status: "error", message: "Incident not found" };
  if (existing.verificationStatus !== VerificationStatus.PENDING) {
    return { code: 409, status: "error", message: `Incident has already been ${existing.verificationStatus.toLowerCase()}` };
  }

  const incident = await prisma.$transaction(async (tx) => {
    const claim = await tx.incident.updateMany({
      where: { incidentId, verificationStatus: VerificationStatus.PENDING },
      data: {
        verificationStatus: input.verificationStatus,
        verificationNotes: input.verificationNotes ?? null,
        verifiedAt: new Date(),
        verifiedBy: actorId,
        status: input.verificationStatus === VerificationStatus.REJECTED ? "CLOSED" : "ACTIVE",
      },
    });
    if (claim.count !== 1) return null;
    const updated = await tx.incident.findUniqueOrThrow({
      where: { incidentId }, include: { type: true, location: true, barangay: true, attachments: true },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: `INCIDENT_${input.verificationStatus}`,
        entityType: "Incident",
        entityId: incidentId,
        metadata: { previousStatus: existing.verificationStatus, notes: input.verificationNotes },
        ipAddress,
      },
    });
    await enqueueNotification(tx, "INCIDENT_VERIFIED", {
      title: `Incident ${input.verificationStatus.toLowerCase()}`,
      body: existing.title,
      data: { incidentId, type: "incident-verification" },
    }, [existing.reportedBy]);
    return updated;
  });

  if (!incident) return { code: 409, status: "error", message: "Another operator already verified this incident. Refresh the incident." };

  publishEmergencyEvent({ type: "incident.verified", entityId: incidentId });
  return { code: 200, status: "success", message: `Incident ${input.verificationStatus.toLowerCase()}`, data: { incident: protectIncidentEvidence(incident) } };
}
