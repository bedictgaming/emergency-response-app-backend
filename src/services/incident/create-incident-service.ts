import { prisma } from "@/lib/prisma";
import { IncidentRepository } from "@/repositories/incident.repository";
import { CreateIncidentInput } from "@/schema/incident/create-incident.schema";
import { ResponseService, Role, SeverityLevel } from "@/generated/prisma";
import { verifyUploadedAsset } from "@/lib/cloudinary";
import { publishEmergencyEvent } from "@/lib/events";
import { WorkflowConflict, isWorkflowConflict } from "@/lib/workflow-error";
import {
  DAILY_CITIZEN_REPORT_LIMIT,
  DAILY_REPORT_LIMIT_MESSAGE,
  DailyReportLimitExceeded,
  getManilaDayRange,
} from "@/lib/daily-report-limit";
import {
  DUPLICATE_INCIDENT_RADIUS_METERS,
  NearbyIncident,
  findMatchingNearbyIncident,
  nearbyIncidentCandidateQuery,
  nearbyIncidentLockKeys,
} from "@/lib/incident-proximity";
import {
  normalizeResponseServices,
  responseServiceFromText,
  unitTypeSupportsService,
} from "@/lib/response-services";
import { enqueueAssetCleanup, enqueueNotification } from "@/lib/jobs";
import { protectIncidentEvidence } from "@/lib/evidence";
import { resolveBarangayFromCoordinates } from "@/lib/barangay-boundaries";
import { departmentService } from "@/lib/department-access";
import { isMainAdministrator } from "@/lib/permissions";

const incidentRepository = new IncidentRepository();

class DuplicateActiveIncidentError extends WorkflowConflict {
  public constructor(public readonly existingIncident: NearbyIncident) {
    super("An emergency of this type has already been reported near this location.");
  }
}

const CORDOVA_BARANGAYS = [
  "Alegria",
  "Bangbang",
  "Buagsong",
  "Catarman",
  "Cogon",
  "Dapitan",
  "Day-as",
  "Gabi",
  "Gilutongan",
  "Ibabao",
  "Pilipog",
  "Poblacion",
  "San Miguel",
];

export const CreateIncidentService = async (
  data: CreateIncidentInput,
  reportedBy: string
) => {
  let verifiedProof: Awaited<ReturnType<typeof verifyUploadedAsset>> | undefined;
  let proofPersisted = false;

  try {
    const reporter = await prisma.user.findUnique({
      where: { id: reportedBy },
      select: { role: true, department: true, isMainAdmin: true },
    });
    if (!reporter) return { code: 401, status: "error", message: "Reporter account not found" };

    const requiresProof = reporter.role === Role.USER;
    if (requiresProof && !data.proofAttachment) {
      return { code: 400, status: "error", message: "A verified proof photo is required for citizen reports" };
    }

    if (data.proofAttachment) {
      try {
        verifiedProof = await verifyUploadedAsset(data.proofAttachment.publicId, reportedBy);
        if (verifiedProof.moderationStatus === "rejected") {
          return { code: 422, status: "error", message: "The proof photo did not pass content moderation" };
        }
        if (verifiedProof.phash) {
          const duplicate = await prisma.attachment.findFirst({
            // Different citizens may legitimately photograph or submit the
            // same emergency. Reuse is only abusive when the same reporter
            // submits the same evidence more than once.
            where: { perceptualHash: verifiedProof.phash, uploadedBy: reportedBy },
            select: { incidentId: true },
          });
          if (duplicate) return { code: 409, status: "error", message: "You already used this proof photo for another incident" };
        }
      } catch (error) {
        return { code: 422, status: "error", message: error instanceof Error ? error.message : "Unable to verify proof photo" };
      }
    }

    const reportDay = getManilaDayRange();
    if (requiresProof) {
      const reportsToday = await prisma.incident.count({
        where: {
          reportedBy,
          reportedAt: { gte: reportDay.start, lt: reportDay.end },
        },
      });
      if (reportsToday >= DAILY_CITIZEN_REPORT_LIMIT) {
        return { code: 429, status: "error", message: DAILY_REPORT_LIMIT_MESSAGE };
      }
    }
    // 1. Resolve Incident Type
    let resolvedTypeId = data.typeId;
    let resolvedTypeName: string | undefined;
    if (!resolvedTypeId) {
      const searchCat = (data.category || data.typeName || "other").toLowerCase();
      let matchedType = null;

      if (searchCat.includes("fire")) {
        matchedType = await prisma.incidentType.findFirst({
          where: { typeName: { contains: "Fire", mode: "insensitive" } },
        });
      } else if (searchCat.includes("med")) {
        matchedType = await prisma.incidentType.findFirst({
          where: { typeName: { contains: "Medical", mode: "insensitive" } },
        });
      } else if (
        searchCat.includes("pol") ||
        searchCat.includes("sec") ||
        searchCat.includes("crime")
      ) {
        matchedType = await prisma.incidentType.findFirst({
          where: { typeName: { contains: "Police", mode: "insensitive" } },
        });
      } else if (
        searchCat.includes("haz") ||
        searchCat.includes("flood") ||
        searchCat.includes("weath")
      ) {
        matchedType = await prisma.incidentType.findFirst({
          where: { typeName: { contains: "Hazard", mode: "insensitive" } },
        });
      } else {
        matchedType = await prisma.incidentType.findFirst({
          where: { typeName: { contains: "General", mode: "insensitive" } },
        });
      }

      if (!matchedType) {
        matchedType = await prisma.incidentType.upsert({
          where: { typeName: "General Emergency" },
          update: {},
          create: {
            typeName: "General Emergency",
            description: "Default incident classification",
          },
        });
      }

      resolvedTypeId = matchedType.typeId;
      resolvedTypeName = matchedType.typeName;
    } else {
      const incidentType = await incidentRepository.findTypeById(resolvedTypeId);
      if (!incidentType) {
        return {
          code: 404,
          status: "error",
          message: "Incident type not found. Please provide a valid typeId.",
        };
      }
      resolvedTypeName = incidentType.typeName;
    }

    const explicitlyRequestedServices = normalizeResponseServices(data.requestedServices);
    const primaryResponseService = responseServiceFromText(resolvedTypeName);
    const targetResponseServices: ResponseService[] = explicitlyRequestedServices.length > 0
      ? explicitlyRequestedServices
      : primaryResponseService ? [primaryResponseService] : [];
    const isOperational = reporter.role === Role.ADMIN || reporter.role === Role.DISPATCHER;
    if (data.duplicateOverrideReason && !isOperational) {
      return { code: 403, status: "error", message: "Only authorized staff can approve a nearby incident override" };
    }
    if (isOperational && !isMainAdministrator(reporter)) {
      const ownService = departmentService(reporter.department);
      if (!ownService || targetResponseServices.some((service) => service !== ownService)) {
        return { code: 403, status: "error", message: "Operational staff may only create or approve incidents for their own department" };
      }
    }

    // 2. Resolve or Create Location
    let resolvedLocationId = data.locationId;
    let resolvedLocation: Awaited<ReturnType<typeof incidentRepository.findLocationById>> | null = null;
    if (resolvedLocationId) {
      resolvedLocation = await incidentRepository.findLocationById(
        resolvedLocationId
      );
      if (!resolvedLocation) {
        return {
          code: 404,
          status: "error",
          message: "Location not found. Please provide a valid locationId.",
        };
      }
    }

    const effectiveLatitude = data.latitude ?? (
      resolvedLocation?.latitude == null ? undefined : Number(resolvedLocation.latitude)
    );
    const effectiveLongitude = data.longitude ?? (
      resolvedLocation?.longitude == null ? undefined : Number(resolvedLocation.longitude)
    );

    if (requiresProof && (
      effectiveLatitude === undefined
      || effectiveLongitude === undefined
      || !Number.isFinite(effectiveLatitude)
      || !Number.isFinite(effectiveLongitude)
    )) {
      return {
        code: 400,
        status: "error",
        message: "Select the emergency location on the map so nearby duplicate reports can be detected",
      };
    }

    // 3. Resolve Barangay
    let resolvedBarangayId = data.barangayId;
    let resolvedBarangayName: string | undefined;
    if (resolvedBarangayId) {
      const barangay = await prisma.barangay.findUnique({ where: { barangayId: resolvedBarangayId }, select: { name: true, status: true } });
      if (!barangay || barangay.status !== "ACTIVE") return { code: 400, status: "error", message: "The selected barangay is unavailable" };
      resolvedBarangayName = barangay.name;
    }
    if (!resolvedBarangayId) {
      const fullText = `${data.barangayName || ""} ${data.address || ""} ${
        data.locationName || ""
      }`.toLowerCase();
      const detectedBarangay = CORDOVA_BARANGAYS.find((b) =>
        fullText.includes(b.toLowerCase())
      );
      if (detectedBarangay) {
        const brgy = await prisma.barangay.findFirst({
          where: { name: { equals: detectedBarangay, mode: "insensitive" } },
        });
        if (brgy) {
          resolvedBarangayId = brgy.barangayId;
          resolvedBarangayName = brgy.name;
        }
      }
    }
    if (effectiveLatitude !== undefined && effectiveLongitude !== undefined && resolvedBarangayName) {
      const coordinateBarangayName = resolveBarangayFromCoordinates(
        resolvedBarangayName,
        effectiveLatitude,
        effectiveLongitude,
      );
      if (!coordinateBarangayName) {
        return { code: 422, status: "error", message: "The selected map location is outside the supported Cordova barangay boundaries. Move the pin within Cordova." };
      }
      if (coordinateBarangayName.toLowerCase() !== resolvedBarangayName.toLowerCase()) {
        const coordinateBarangay = await prisma.barangay.findFirst({
          where: { name: { equals: coordinateBarangayName, mode: "insensitive" }, status: "ACTIVE" },
          select: { barangayId: true, name: true },
        });
        if (!coordinateBarangay) {
          return { code: 400, status: "error", message: "The detected incident barangay is unavailable" };
        }
        resolvedBarangayId = coordinateBarangay.barangayId;
        resolvedBarangayName = coordinateBarangay.name;
      }
    }
    if (!resolvedBarangayId) {
      return {
        code: 400,
        status: "error",
        message: "A valid Cordova barangay is required. Include barangayId or a recognized barangay name in the address.",
      };
    }

    // 4. Format Description (include reporter phone if provided)
    let fullDescription = data.description?.trim() || "";
    if (data.reporterPhone?.trim()) {
      fullDescription = `[Contact: ${data.reporterPhone.trim()}]\n${fullDescription}`.trim();
    }

    // 5. Create the incident and its verified proof atomically.
    const incident = await prisma.$transaction(async (tx) => {
      let approvedDuplicateOverride = false;
      // Serialize submissions for this reporter, then repeat checks under lock.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${reportedBy} FOR UPDATE`;
      if (requiresProof) {
        const reportsToday = await tx.incident.count({
          where: {
            reportedBy,
            reportedAt: { gte: reportDay.start, lt: reportDay.end },
          },
        });
        if (reportsToday >= DAILY_CITIZEN_REPORT_LIMIT) {
          throw new DailyReportLimitExceeded(DAILY_REPORT_LIMIT_MESSAGE);
        }
      }
      if (verifiedProof?.phash) {
        const reporterProofKey = `${reportedBy}:${verifiedProof.phash}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${reporterProofKey}, 0))`;
        if (await tx.attachment.findFirst({ where: { perceptualHash: verifiedProof.phash, uploadedBy: reportedBy } })) {
          throw new WorkflowConflict("You already used this proof photo for another incident");
        }
      }
      if (effectiveLatitude !== undefined && effectiveLongitude !== undefined
        && Number.isFinite(effectiveLatitude) && Number.isFinite(effectiveLongitude)) {
        // Neighboring geographic cells share advisory locks even when their
        // resolved barangays differ. Lock all requested services in stable
        // order before the authoritative duplicate read.
        const areaLockServices = targetResponseServices.length > 0
          ? [...targetResponseServices].sort()
          : [resolvedTypeId!];
        const areaLockKeys = nearbyIncidentLockKeys(effectiveLatitude!, effectiveLongitude!, areaLockServices);
        // A recursive CTE acquires the same sorted locks sequentially on the
        // server, without one network round trip per geographic cell. The
        // recursion dependency preserves lock order for concurrent reporters.
        await tx.$queryRaw`
          WITH RECURSIVE lock_sequence(position, acquired) AS (
            SELECT 1, pg_advisory_xact_lock(hashtextextended((${areaLockKeys}::text[])[1], 0))
            UNION ALL
            SELECT position + 1,
              pg_advisory_xact_lock(hashtextextended((${areaLockKeys}::text[])[position + 1], 0))
            FROM lock_sequence
            WHERE position < cardinality(${areaLockKeys}::text[])
          )
          SELECT count(*)::int AS acquired FROM lock_sequence
        `;

        const nearbyCandidates = await tx.incident.findMany(
          nearbyIncidentCandidateQuery(effectiveLatitude!, effectiveLongitude!),
        );
        const duplicate = findMatchingNearbyIncident(
          nearbyCandidates,
          effectiveLatitude!,
          effectiveLongitude!,
          targetResponseServices,
          resolvedTypeId,
        );
        if (duplicate && !data.duplicateOverrideReason) throw new DuplicateActiveIncidentError(duplicate);
        approvedDuplicateOverride = Boolean(duplicate && data.duplicateOverrideReason);
      }
      if (!resolvedLocationId) {
        const location = await tx.location.create({ data: {
          locationName: data.locationName || data.address || "Cordova Incident Location",
          address: data.address || data.locationName || null,
          city: "Cordova", province: "Cebu", latitude: effectiveLatitude, longitude: effectiveLongitude,
        } });
        resolvedLocationId = location.locationId;
      }
      const created = await tx.incident.create({
        data: {
          title: data.title,
          description: fullDescription || undefined,
          typeId: resolvedTypeId!,
          locationId: resolvedLocationId!,
          barangayId: resolvedBarangayId,
          latitude: effectiveLatitude,
          longitude: effectiveLongitude,
          severityLevel: data.severityLevel || SeverityLevel.MEDIUM,
          requestedServices: explicitlyRequestedServices,
          status: "RESPONDING",
          verificationStatus: "VERIFIED",
          verifiedAt: new Date(),
          reportedBy,
          attachments: verifiedProof && data.proofAttachment ? {
            create: {
              fileName: data.proofAttachment.fileName,
              fileType: `image/${verifiedProof.format}`,
              fileUrl: verifiedProof.url,
              publicId: verifiedProof.publicId,
              format: verifiedProof.format,
              bytes: verifiedProof.bytes,
              width: verifiedProof.width,
              height: verifiedProof.height,
              perceptualHash: verifiedProof.phash,
              moderationStatus: verifiedProof.moderationStatus,
              verifiedAt: new Date(),
              uploadedBy: reportedBy,
            },
          } : undefined,
          serviceResponses: targetResponseServices.length > 0 ? {
            create: targetResponseServices.map(service => ({ service })),
          } : undefined,
        },
        include: { type: true, location: true, barangay: true, attachments: true, serviceResponses: true },
      });
      await tx.auditLog.create({
        data: { actorId: reportedBy, action: approvedDuplicateOverride ? "INCIDENT_DUPLICATE_OVERRIDE" : "INCIDENT_CREATED", entityType: "Incident", entityId: created.incidentId, metadata: approvedDuplicateOverride ? { reason: data.duplicateOverrideReason } : undefined },
      });
      if (targetResponseServices.length > 0) {
        const responderAccounts = await tx.responder.findMany({
          where: { status: { not: "OFF_DUTY" }, user: { status: "ACTIVE" } },
          select: { userId: true, unit: { select: { unitType: true } } },
        });
        const recipientIds = responderAccounts
          .filter((responder) => unitTypeSupportsService(responder.unit.unitType, targetResponseServices))
          .map((responder) => responder.userId);
        await enqueueNotification(tx, "INCIDENT_CREATED", {
          title: "New emergency response request",
          body: "A new incident requires your response service.",
          data: { incidentId: created.incidentId },
        }, recipientIds);
      }
      return created;
    });
    proofPersisted = Boolean(verifiedProof);

    publishEmergencyEvent({ type: "incident.created", entityId: incident.incidentId });

    return {
      code: 201,
      status: "success",
      message: "Incident reported successfully",
      data: { incident: protectIncidentEvidence(incident) },
    };
  } catch (error) {
    if (error instanceof DailyReportLimitExceeded) {
      return { code: 429, status: "error", message: error.message };
    }
    if (error instanceof DuplicateActiveIncidentError) {
      const distanceMeters = Math.round(error.existingIncident.distanceMeters);
      await prisma.auditLog.create({
        data: {
          actorId: reportedBy,
          action: "INCIDENT_DUPLICATE_REJECTED",
          entityType: "Incident",
          entityId: error.existingIncident.incidentId,
          metadata: {
            distanceMeters,
            radiusMeters: DUPLICATE_INCIDENT_RADIUS_METERS,
          },
        },
      }).catch(() => undefined);
      return {
        code: 409,
        status: "error",
        errorCode: "DUPLICATE_ACTIVE_INCIDENT",
        message: "A similar active emergency has already been reported nearby. Your report was not submitted.",
      };
    }
    if (isWorkflowConflict(error)) return { code: 409, status: "error", message: error instanceof WorkflowConflict ? error.message : "The report or evidence was already submitted. Refresh before retrying." };
    console.error("CreateIncidentService Error", error);
    return { code: 500, status: "error", message: "Failed to create incident" };
  } finally {
    // Direct uploads happen before incident creation. If validation, the daily
    // quota, or a transaction rejects the report, remove that unreferenced
    // asset so retries do not leak orphaned Cloudinary files.
    if (verifiedProof && !proofPersisted) {
      try {
        const referenced = await prisma.attachment.findUnique({
          where: { publicId: verifiedProof.publicId },
          select: { attachmentId: true },
        });
        if (!referenced) {
          await prisma.$transaction((tx) => enqueueAssetCleanup(tx, verifiedProof!.publicId));
        }
      } catch (error) {
        // A temporary database failure must never cause evidence to be deleted.
        console.error("Unable to enqueue unreferenced evidence cleanup", error);
      }
    }
  }
};
