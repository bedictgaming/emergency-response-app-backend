import { prisma } from "@/lib/prisma";
import { IncidentUnitStatus, Prisma, UnitStatus } from "@/generated/prisma";

interface CreateIncidentUnitData {
  incidentId: string;
  unitId: string;
  role?: string;
  status?: IncidentUnitStatus;
}

interface UpdateIncidentUnitData {
  role?: string;
  status?: IncidentUnitStatus;
}

interface IncidentUnitFilters {
  incidentId?: string;
  unitId?: string;
  status?: IncidentUnitStatus;
  assignedUserId?: string;
  dispatchScope?: Prisma.IncidentUnitWhereInput;
}

export class IncidentUnitRepository {
  async findAll(filters?: IncidentUnitFilters) {
    return await prisma.incidentUnit.findMany({
      where: {
        ...(filters?.assignedUserId && { unit: { responders: { some: { userId: filters.assignedUserId } } } }),
        ...(filters?.dispatchScope && { AND: [filters.dispatchScope] }),
        ...(filters?.incidentId && { incidentId: filters.incidentId }),
        ...(filters?.unitId && { unitId: filters.unitId }),
        ...(filters?.status && { status: filters.status }),
      },
      include: {
        incident: {
          select: {
            incidentId: true,
            title: true,
            status: true,
            severityLevel: true,
            location: true,
          },
        },
        unit: {
          select: {
            unitId: true,
            unitName: true,
            unitType: true,
            status: true,
          },
        },
      },
      orderBy: { assignedAt: "desc" },
    });
  }

  async findById(id: string) {
    return await prisma.incidentUnit.findUnique({
      where: { incidentUnitId: id },
      include: {
        incident: {
          select: {
            incidentId: true,
            title: true,
            status: true,
            severityLevel: true,
            location: true,
          },
        },
        unit: {
          select: {
            unitId: true,
            unitName: true,
            unitType: true,
            status: true,
            responders: {
              include: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
      },
    });
  }

  async findByIncidentAndUnit(incidentId: string, unitId: string) {
    return await prisma.incidentUnit.findUnique({
      where: {
        incidentId_unitId: {
          incidentId,
          unitId,
        },
      },
      include: {
        unit: true,
      },
    });
  }

  async create(data: CreateIncidentUnitData) {
    return await prisma.incidentUnit.create({
      data: {
        incidentId: data.incidentId,
        unitId: data.unitId,
        role: data.role,
        status: data.status ?? IncidentUnitStatus.DISPATCHED,
      },
      include: {
        unit: true,
        incident: {
          select: { incidentId: true, title: true, status: true },
        },
      },
    });
  }

  async update(id: string, data: UpdateIncidentUnitData) {
    return await prisma.incidentUnit.update({
      where: { incidentUnitId: id },
      data: {
        ...(data.role !== undefined && { role: data.role }),
        ...(data.status && { status: data.status }),
      },
      include: {
        unit: true,
        incident: {
          select: { incidentId: true, title: true, status: true },
        },
      },
    });
  }

  async delete(id: string) {
    return await prisma.incidentUnit.delete({
      where: { incidentUnitId: id },
      include: {
        unit: true,
      },
    });
  }

  async deleteByIncidentAndUnit(incidentId: string, unitId: string) {
    return await prisma.incidentUnit.delete({
      where: {
        incidentId_unitId: {
          incidentId,
          unitId,
        },
      },
      include: {
        unit: true,
      },
    });
  }

  async findIncidentById(incidentId: string) {
    return await prisma.incident.findUnique({
      where: { incidentId },
    });
  }

  async findUnitById(unitId: string) {
    return await prisma.unit.findUnique({
      where: { unitId },
    });
  }

  async setUnitStatus(unitId: string, status: UnitStatus) {
    return await prisma.unit.update({
      where: { unitId },
      data: { status },
    });
  }

  async countActiveDispatchesForUnit(unitId: string, excludeIncidentId?: string) {
    return await prisma.incidentUnit.count({
      where: {
        unitId,
        status: { in: [IncidentUnitStatus.DISPATCHED, IncidentUnitStatus.EN_ROUTE, IncidentUnitStatus.ON_SCENE] },
        ...(excludeIncidentId && { incidentId: { not: excludeIncidentId } }),
      },
    });
  }
}
