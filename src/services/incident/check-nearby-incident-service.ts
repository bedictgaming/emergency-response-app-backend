import { prisma } from "@/lib/prisma";
import { findMatchingNearbyIncident, nearbyIncidentCandidateQuery } from "@/lib/incident-proximity";
import { CheckNearbyIncidentInput } from "@/schema/incident/check-nearby-incident.schema";
import {
  normalizeResponseServices,
  responseServiceFromText,
} from "@/lib/response-services";
import { resolveBarangayFromCoordinates } from "@/lib/barangay-boundaries";

function categorySearchTerm(category: string): string | undefined {
  const normalized = category.trim().toLowerCase();
  if (normalized.includes("fire")) return "Fire";
  if (normalized.includes("med")) return "Medical";
  if (normalized.includes("pol") || normalized.includes("sec") || normalized.includes("crime")) return "Police";
  if (normalized.includes("haz") || normalized.includes("flood") || normalized.includes("weath")) return "Hazard";
  return undefined;
}

export async function CheckNearbyIncidentService(data: CheckNearbyIncidentInput) {
  const resolvedBarangayName = resolveBarangayFromCoordinates(
    data.barangayName,
    data.latitude,
    data.longitude,
  );
  if (!resolvedBarangayName) {
    return {
      code: 200,
      status: "success",
      data: {
        duplicate: false,
        locationAccepted: false,
        message: "The selected map location is outside the supported Cordova barangay boundaries. Move the pin within Cordova before uploading a photo.",
      },
    };
  }
  const requestedServices = normalizeResponseServices(data.requestedServices);
  const primaryService = responseServiceFromText(data.category);
  const targetServices = requestedServices.length > 0
    ? requestedServices
    : primaryService ? [primaryService] : [];
  const typeSearch = categorySearchTerm(data.category) || "General";

  const [incidentType, barangay] = await Promise.all([
    prisma.incidentType.findFirst({
      where: { typeName: { contains: typeSearch, mode: "insensitive" } },
      select: { typeId: true },
    }),
    prisma.barangay.findFirst({
      where: { name: { equals: resolvedBarangayName, mode: "insensitive" }, status: "ACTIVE" },
      select: { barangayId: true },
    }),
  ]);

  if (!barangay) {
    return { code: 200, status: "success", data: { duplicate: false, locationAccepted: false, message: "The selected barangay is unavailable. Choose an active Cordova barangay." } };
  }

  if (!incidentType && targetServices.length === 0) {
    return { code: 200, status: "success", data: { duplicate: false, locationAccepted: true, barangayName: resolvedBarangayName } };
  }

  const candidates = await prisma.incident.findMany(nearbyIncidentCandidateQuery(data.latitude, data.longitude));
  const nearby = findMatchingNearbyIncident(
    candidates,
    data.latitude,
    data.longitude,
    targetServices,
    incidentType?.typeId,
  );

  if (!nearby) {
    return { code: 200, status: "success", data: { duplicate: false, locationAccepted: true, barangayName: resolvedBarangayName } };
  }

  return {
    code: 200,
    status: "success",
    data: {
      duplicate: true,
      locationAccepted: true,
      barangayName: resolvedBarangayName,
      message: "A similar active emergency has already been reported nearby. Your report was not submitted.",
    },
  };
}
