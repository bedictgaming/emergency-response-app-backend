import { prisma } from "@/lib/prisma";
import { Department, IncidentStatus, Prisma, ResponseService, ServiceResponseStatus, SeverityLevel } from "@/generated/prisma";
import { responderIncidentScope } from '@/lib/incident-scope';
import { reviewNoticeIncidentScope, type ReviewNoticeScope } from '@/domain/incident-review-notices.policy';

interface CreateIncidentData {
  title: string;
  description?: string;
  typeId: string;
  locationId: string;
  barangayId?: string;
  latitude?: number;
  longitude?: number;
  severityLevel: SeverityLevel;
  reportedBy: string;
}

interface UpdateIncidentData {
  title?: string;
  description?: string;
  typeId?: string;
  locationId?: string;
  barangayId?: string;
  latitude?: number;
  longitude?: number;
  severityLevel?: SeverityLevel;
  status?: IncidentStatus;
}

interface IncidentFilters {
  search?: string;
  typeName?: string;
  historyFrom?: Date;
  historyBefore?: Date;
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
  includeAttachments?: boolean;
  includeUnits?: boolean;
  reviewDepartment?: Department | "ALL";
  reviewNoticeDepartment?: ReviewNoticeScope;
}

const reviewFlagInclude = (department?: Department | "ALL") => department ? {
  where: { status: { not: "DISMISSED" as const }, ...(department !== "ALL" && { department }) },
  orderBy: { createdAt: "asc" as const },
} : false;

const sharedReviewInclude = { orderBy: [{ createdAt: 'asc' as const }, { reviewFlagId: 'asc' as const }], take: 5 };

// Always intersect search/date constraints with authorization, never replace it.
const historyWhere = (filters?: IncidentFilters): Prisma.IncidentWhereInput => ({
  ...(filters?.search && { OR: [
    { title: { contains: filters.search, mode: "insensitive" } },
    { description: { contains: filters.search, mode: "insensitive" } },
    { barangay: { is: { name: { contains: filters.search, mode: "insensitive" } } } },
    { type: { is: { typeName: { contains: filters.search, mode: "insensitive" } } } },
    { reporter: { is: { name: { contains: filters.search, mode: "insensitive" } } } },
  ] }),
  ...(filters?.typeName && { type: { is: { typeName: { equals: filters.typeName, mode: "insensitive" } } } }),
  ...((filters?.historyFrom || filters?.historyBefore) && { reportedAt: {
    ...(filters.historyFrom && { gte: filters.historyFrom }),
    ...(filters.historyBefore && { lt: filters.historyBefore }),
  } }),
});
const historyScope = (filters?: IncidentFilters) => {
  const where = historyWhere(filters);
  return Object.keys(where).length ? [where] : [];
};

export class IncidentRepository {
  async findAll(filters?: IncidentFilters) {
    return await prisma.incident.findMany({
      where: {
        AND: [filters?.scope ?? {}, ...historyScope(filters),
          ...(filters?.responseService && filters.serviceStatuses?.length ? [{
            OR: [
              ...(filters.serviceStatuses.includes('CANCELLED') ? [{ status: 'CANCELLED' as const }] : []),
              ...(filters.serviceStatuses.some(status => status !== 'CANCELLED') ? [{
                status: { not: 'CANCELLED' as const },
                serviceResponses: { some: { service: filters.responseService, status: { in: filters.serviceStatuses.filter(status => status !== 'CANCELLED') } } },
              }] : []),
            ],
          }] : []),
        ],
        ...(filters?.responderId && responderIncidentScope(filters.responderId)),
        ...(filters?.statuses?.length
          ? { status: { in: filters.statuses } }
          : filters?.status && { status: filters.status }),
        ...(filters?.responseService && {
          serviceResponses: {
            some: {
              service: filters.responseService,
            },
          },
        }),
        ...(filters?.severityLevel && { severityLevel: filters.severityLevel }),
        ...(filters?.typeId && { typeId: filters.typeId }),
        ...(filters?.locationId && { locationId: filters.locationId }),
        ...(filters?.barangayId && { barangayId: filters.barangayId }),
        ...(filters?.reportedBy && { reportedBy: filters.reportedBy }),
        ...((filters?.from || filters?.to) && { reportedAt: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) } }),
      },
      include: {
        type: true,
        location: true,
        barangay: true,
        reporter: {
          select: { id: true, name: true, email: true, role: true },
        },
        incidentUnits: filters?.includeUnits ? {
          include: {
            unit: true,
          },
        } : false,
        attachments: filters?.includeAttachments ? {
          orderBy: { uploadedAt: "desc" },
          take: 1,
        } : false,
        serviceResponses: true,
        reviewFlags: filters?.reviewNoticeDepartment ? sharedReviewInclude : reviewFlagInclude(filters?.reviewDepartment),
      },
      orderBy: [{ reportedAt: "desc" }, { incidentId: "desc" }],
      skip: ((filters?.page ?? 1) - 1) * (filters?.limit ?? 50),
      take: filters?.limit ?? 50,
    });
  }

  async count(filters?: IncidentFilters) {
    return prisma.incident.count({ where: {
      AND: [filters?.scope ?? {}, ...historyScope(filters)],
      ...(filters?.responderId && responderIncidentScope(filters.responderId)),
      ...(filters?.statuses?.length
        ? { status: { in: filters.statuses } }
        : filters?.status && { status: filters.status }),
      ...(filters?.severityLevel && { severityLevel: filters.severityLevel }),
      ...(filters?.typeId && { typeId: filters.typeId }),
      ...(filters?.locationId && { locationId: filters.locationId }),
      ...(filters?.barangayId && { barangayId: filters.barangayId }),
      ...(filters?.reportedBy && { reportedBy: filters.reportedBy }),
      ...((filters?.from || filters?.to) && { reportedAt: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) } }),
    } });
  }

  async countByStatus(filters?: IncidentFilters) {
    return prisma.incident.groupBy({
      by: ["status"],
      where: {
        AND: [filters?.scope ?? {}, ...historyScope(filters)],
        ...(filters?.responderId && responderIncidentScope(filters.responderId)),
        ...(filters?.severityLevel && { severityLevel: filters.severityLevel }),
        ...(filters?.typeId && { typeId: filters.typeId }),
        ...(filters?.locationId && { locationId: filters.locationId }),
        ...(filters?.barangayId && { barangayId: filters.barangayId }),
        ...(filters?.reportedBy && { reportedBy: filters.reportedBy }),
        ...((filters?.from || filters?.to) && { reportedAt: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) } }),
      },
      _count: { _all: true },
    });
  }

  async countByServiceStatus(filters: IncidentFilters, service: ResponseService) {
    const incidentScope: Prisma.IncidentWhereInput = {
      AND: [filters.scope ?? {}, ...historyScope(filters)],
      ...(filters.responderId && responderIncidentScope(filters.responderId)),
      ...(filters.severityLevel && { severityLevel: filters.severityLevel }),
      ...(filters.typeId && { typeId: filters.typeId }),
      ...(filters.locationId && { locationId: filters.locationId }),
      ...(filters.barangayId && { barangayId: filters.barangayId }),
      ...(filters.reportedBy && { reportedBy: filters.reportedBy }),
      ...((filters.from || filters.to) && { reportedAt: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) } }),
    };
    const [rows, cancelled] = await Promise.all([prisma.incidentServiceResponse.groupBy({
      by: ["status"],
      where: {
        service,
        incident: {
          is: {
            AND: [incidentScope, { status: { not: 'CANCELLED' } }],
          },
        },
      },
      _count: { _all: true },
    }), prisma.incident.count({ where: { AND: [incidentScope, { status: 'CANCELLED' }], serviceResponses: { some: { service } } } })]);
    // Already resolved department history is retained. The parent cancellation
    // still belongs exclusively in Cancelled, never both Resolved and Cancelled.
    return [...rows, { status: ServiceResponseStatus.CANCELLED, _count: { _all: cancelled } }];
  }

  async countByResponseService(filters?: IncidentFilters) {
    return prisma.incidentServiceResponse.groupBy({
      by: ["service"],
      where: {
        incident: {
          is: {
            AND: [filters?.scope ?? {}, ...historyScope(filters)],
            ...(filters?.responderId && responderIncidentScope(filters.responderId)),
            ...(filters?.severityLevel && { severityLevel: filters.severityLevel }),
            ...(filters?.typeId && { typeId: filters.typeId }),
            ...(filters?.locationId && { locationId: filters.locationId }),
            ...(filters?.barangayId && { barangayId: filters.barangayId }),
            ...(filters?.reportedBy && { reportedBy: filters.reportedBy }),
            ...((filters?.from || filters?.to) && { reportedAt: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) } }),
          },
        },
      },
      _count: { _all: true },
    });
  }


  async findById(id: string, reviewDepartment?: Department | "ALL", reviewNoticeDepartment?: ReviewNoticeScope) {
    return await prisma.incident.findUnique({
      where: { incidentId: id, ...(reviewNoticeDepartment && { AND: [reviewNoticeIncidentScope(reviewNoticeDepartment)] }) },
      include: {
        type: true,
        location: true,
        barangay: true,
        reporter: {
          select: { id: true, name: true, email: true, role: true },
        },
        incidentUnits: {
          include: {
            unit: true,
          },
        },
        tasks: {
          include: {
            assignee: {
              include: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        attachments: {
          include: {
            uploader: { select: { id: true, name: true, email: true } },
          },
          orderBy: { uploadedAt: "desc" },
        },
        serviceResponses: true,
        reviewFlags: reviewNoticeDepartment ? sharedReviewInclude : reviewFlagInclude(reviewDepartment),
      },
    });
  }

  async create(data: CreateIncidentData) {
    return await prisma.incident.create({
      data: {
        title: data.title,
        description: data.description,
        typeId: data.typeId,
        locationId: data.locationId,
        barangayId: data.barangayId,
        latitude: data.latitude,
        longitude: data.longitude,
        severityLevel: data.severityLevel,
        reportedBy: data.reportedBy,
      },
      include: {
        type: true,
        location: true,
        barangay: true,
        reporter: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });
  }

  async update(id: string, data: UpdateIncidentData) {
    return await prisma.incident.update({
      where: { incidentId: id },
      data: {
        ...(data.title && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.typeId && { typeId: data.typeId }),
        ...(data.locationId && { locationId: data.locationId }),
        ...(data.latitude !== undefined && { latitude: data.latitude }),
        ...(data.longitude !== undefined && { longitude: data.longitude }),
        ...(data.severityLevel && { severityLevel: data.severityLevel }),
        ...(data.status && { status: data.status }),
      },
      include: {
        type: true,
        location: true,
        reporter: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });
  }

  async delete(id: string) {
    return await prisma.incident.delete({
      where: { incidentId: id },
    });
  }

  async findTypeById(typeId: string) {
    return await prisma.incidentType.findUnique({
      where: { typeId },
    });
  }

  async findLocationById(locationId: string) {
    return await prisma.location.findUnique({
      where: { locationId },
    });
  }
}
