import { prisma } from "@/lib/prisma";
import { IncidentStatus, Prisma, ResponseService, ServiceResponseStatus, SeverityLevel } from "@/generated/prisma";
import { responderIncidentScope } from '@/lib/incident-scope';

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
}

export class IncidentRepository {
  async findAll(filters?: IncidentFilters) {
    return await prisma.incident.findMany({
      where: {
        AND: [filters?.scope ?? {}],
        ...(filters?.responderId && responderIncidentScope(filters.responderId)),
        ...(filters?.statuses?.length
          ? { status: { in: filters.statuses } }
          : filters?.status && { status: filters.status }),
        ...(filters?.responseService && {
          serviceResponses: {
            some: {
              service: filters.responseService,
              ...(filters.serviceStatuses?.length && { status: { in: filters.serviceStatuses } }),
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
      },
      orderBy: { reportedAt: "desc" },
      skip: ((filters?.page ?? 1) - 1) * (filters?.limit ?? 50),
      take: filters?.limit ?? 50,
    });
  }

  async count(filters?: IncidentFilters) {
    return prisma.incident.count({ where: {
      AND: [filters?.scope ?? {}],
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
        AND: [filters?.scope ?? {}],
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
    return prisma.incidentServiceResponse.groupBy({
      by: ["status"],
      where: {
        service,
        incident: {
          is: {
            AND: [filters.scope ?? {}],
            ...(filters.responderId && responderIncidentScope(filters.responderId)),
            ...(filters.severityLevel && { severityLevel: filters.severityLevel }),
            ...(filters.typeId && { typeId: filters.typeId }),
            ...(filters.locationId && { locationId: filters.locationId }),
            ...(filters.barangayId && { barangayId: filters.barangayId }),
            ...(filters.reportedBy && { reportedBy: filters.reportedBy }),
            ...((filters.from || filters.to) && { reportedAt: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) } }),
          },
        },
      },
      _count: { _all: true },
    });
  }

  async countByResponseService(filters?: IncidentFilters) {
    return prisma.incidentServiceResponse.groupBy({
      by: ["service"],
      where: {
        incident: {
          is: {
            AND: [filters?.scope ?? {}],
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


  async findById(id: string) {
    return await prisma.incident.findUnique({
      where: { incidentId: id },
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
