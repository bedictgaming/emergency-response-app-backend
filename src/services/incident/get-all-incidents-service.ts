import { IncidentRepository } from "@/repositories/incident.repository";
import { IncidentStatus, Prisma, ResponseService, ServiceResponseStatus, SeverityLevel } from "@/generated/prisma";
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
  includeAttachments?: boolean;
  includeUnits?: boolean;
}

export const GetAllIncidentsService = async (filters?: GetAllIncidentsFilters) => {
  try {
    // Live emergency monitoring only needs the latest incidents. Avoid the
    // additional filtered COUNT query on every poll, while keeping the
    // normal dashboard pagination response unchanged.
    const [incidents, groupedCounts, groupedServiceCounts] = await Promise.all([
      incidentRepository.findAll(filters),
      filters?.includeTotal === false
        ? Promise.resolve(undefined)
        : filters?.responseService
          ? incidentRepository.countByServiceStatus(filters, filters.responseService)
          : incidentRepository.countByStatus(filters),
      filters?.includeTotal !== false && filters?.includeServiceSummary
        ? incidentRepository.countByResponseService(filters)
        : Promise.resolve(undefined),
    ]);

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
