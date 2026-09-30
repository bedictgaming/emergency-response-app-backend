import { IncidentRepository } from "@/repositories/incident.repository";
import { Department, IncidentStatus, Prisma, ResponseService, ServiceResponseStatus, SeverityLevel } from "@/generated/prisma";
import { protectIncidentEvidence } from "@/lib/evidence";

const incidentRepository = new IncidentRepository();

interface GetAllIncidentsFilters {
  responderId?: string;
  status?: IncidentStatus;
  statuses?: IncidentStatus[];
  responseService?: ResponseService;
  serviceStatuses?: ServiceResponseStatus[];
  severityLevel?: SeverityLevel;
  typeId?: string;
  locationId?: string;
  barangayId?: string;
  reportedBy?: string;
  scope?: Prisma.IncidentWhereInput;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
  includeTotal?: boolean;
  includeServiceSummary?: boolean;
  includeVerifiedSummary?: boolean;
  includeAttachments?: boolean;
  includeUnits?: boolean;
  reviewDepartment?: Department | "ALL";
}

export const GetAllIncidentsService = async (filters?: GetAllIncidentsFilters) => {
  try {
    // Live emergency monitoring only needs the latest incidents. Avoid the
    // additional filtered COUNT query on every poll, while keeping the
    // normal dashboard pagination response unchanged.
    // Intersect with authorization; keep the review list and its totals intact.
    const verifiedFilters = {
      ...filters,
      scope: { AND: [filters?.scope ?? {}, { verificationStatus: "VERIFIED" as const }] },
    };
    const includeVerifiedSummary = filters?.includeTotal !== false
      && filters?.includeVerifiedSummary && !filters?.responseService;
    const [incidents, groupedCounts, groupedServiceCounts, verifiedCounts, verifiedServices] = await Promise.all([
      incidentRepository.findAll(filters),
      filters?.includeTotal === false
        ? Promise.resolve(undefined)
        : filters?.responseService
          ? incidentRepository.countByServiceStatus(filters, filters.responseService)
          : incidentRepository.countByStatus(filters),
      filters?.includeTotal !== false && filters?.includeServiceSummary
        ? incidentRepository.countByResponseService(filters)
        : Promise.resolve(undefined),
      includeVerifiedSummary ? incidentRepository.countByStatus(verifiedFilters) : Promise.resolve(undefined),
      includeVerifiedSummary ? incidentRepository.countByResponseService(verifiedFilters) : Promise.resolve(undefined),
    ]);

    const verified = verifiedCounts && {
      total: verifiedCounts.reduce((sum, row) => sum + row._count._all, 0),
      active: verifiedCounts.reduce((sum, row) => sum + (["OPEN", "ACTIVE"].includes(row.status) ? row._count._all : 0), 0),
      responding: verifiedCounts.reduce((sum, row) => sum + (row.status === "RESPONDING" ? row._count._all : 0), 0),
      resolved: verifiedCounts.reduce((sum, row) => sum + (["RESOLVED", "CLOSED"].includes(row.status) ? row._count._all : 0), 0),
      services: {
        fire: verifiedServices?.find(row => row.service === "FIRE")?._count._all ?? 0,
        medical: verifiedServices?.find(row => row.service === "MEDICAL")?._count._all ?? 0,
        police: verifiedServices?.find(row => row.service === "POLICE")?._count._all ?? 0,
        hazard: verifiedServices?.find(row => row.service === "HAZARD")?._count._all ?? 0,
      },
    };

    const counts = filters?.responseService
      ? undefined
      : groupedCounts?.reduce<Record<IncidentStatus, number>>((result, row) => {
        result[row.status as IncidentStatus] = row._count._all;
        return result;
      }, {
        OPEN: 0,
        ACTIVE: 0,
        RESPONDING: 0,
        RESOLVED: 0,
        CLOSED: 0,
      });
    const serviceCounts = filters?.responseService && groupedCounts?.reduce<Record<ServiceResponseStatus, number>>((result, row) => {
      result[row.status as ServiceResponseStatus] = row._count._all;
      return result;
    }, { RESPONDING: 0, RESOLVED: 0 });
    const allTotal = counts
      ? Object.values(counts).reduce((sum, count) => sum + count, 0)
      : serviceCounts
        ? Object.values(serviceCounts).reduce((sum, count) => sum + count, 0)
        : undefined;
    const selectedStatuses = filters?.statuses?.length
      ? filters.statuses
      : filters?.status
        ? [filters.status]
        : undefined;
    const total = serviceCounts
      ? filters?.serviceStatuses?.reduce((sum, status) => sum + serviceCounts[status], 0) ?? allTotal
      : counts
        ? selectedStatuses?.reduce((sum, status) => sum + counts[status], 0) ?? allTotal
        : undefined;
    const responseServiceCounts = groupedServiceCounts?.reduce<Record<ResponseService, number>>((result, row) => {
      result[row.service as ResponseService] = row._count._all;
      return result;
    }, { FIRE: 0, MEDICAL: 0, POLICE: 0, HAZARD: 0 });

    return {
      code: 200,
      status: "success",
      data: {
        incidents: incidents.map(protectIncidentEvidence),
        ...(verified && { verifiedSummary: verified }),
        ...(total !== undefined && {
          pagination: { page: filters?.page ?? 1, limit: filters?.limit ?? 50, total, pages: Math.ceil(total / (filters?.limit ?? 50)) },
          summary: {
            total: allTotal,
            active: counts ? counts.OPEN + counts.ACTIVE : 0,
            responding: serviceCounts?.RESPONDING ?? counts!.RESPONDING,
            resolved: serviceCounts?.RESOLVED ?? (counts!.RESOLVED + counts!.CLOSED),
            ...(responseServiceCounts && {
              services: {
                fire: responseServiceCounts.FIRE,
                medical: responseServiceCounts.MEDICAL,
                police: responseServiceCounts.POLICE,
                hazard: responseServiceCounts.HAZARD,
              },
            }),
          },
        }),
      },
    };
  } catch (error) {
    console.error("GetAllIncidentsService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch incidents" };
  }
};
