import { prisma } from "@/lib/prisma";
import { Prisma, UnitStatus } from "@/generated/prisma";

interface CreateUnitData {
  unitName: string;
  unitType: string;
  status?: UnitStatus;
}

interface UpdateUnitData {
  unitName?: string;
  unitType?: string;
  status?: UnitStatus;
}

interface UnitFilters {
  status?: UnitStatus;
  unitType?: string;
  scope?: Prisma.UnitWhereInput;
  responderUserId?: string;
}

export class UnitRepository {
  async findAll(filters?: UnitFilters) {
    return await prisma.unit.findMany({
      where: {
        AND: [filters?.scope ?? {}],
        ...(filters?.responderUserId && { responders: { some: { userId: filters.responderUserId } } }),
        ...(filters?.status && { status: filters.status }),
        ...(filters?.unitType && {
          unitType: { contains: filters.unitType, mode: "insensitive" },
        }),
      },
      include: {
        _count: {
          select: { responders: true, resources: true, incidentUnits: true },
        },
      },
      orderBy: { unitName: "asc" },
    });
  }

  async findById(id: string) {
    return await prisma.unit.findUnique({
      where: { unitId: id },
      include: {
        responders: {
          include: {
            user: { select: { id: true, name: true, email: true, role: true } },
          },
        },
        resources: true,
        incidentUnits: {
          include: {
            incident: {
              select: {
                incidentId: true,
                title: true,
                status: true,
                severityLevel: true,
                reportedAt: true,
              },
            },
          },
          orderBy: { assignedAt: "desc" },
        },
        _count: {
          select: { responders: true, resources: true, incidentUnits: true },
        },
      },
    });
  }

  async findByName(unitName: string) {
    return await prisma.unit.findFirst({
      where: { unitName },
    });
  }

  async create(data: CreateUnitData) {
    return await prisma.unit.create({
      data: {
        unitName: data.unitName,
        unitType: data.unitType,
        status: data.status ?? UnitStatus.AVAILABLE,
      },
    });
  }

  async update(id: string, data: UpdateUnitData) {
    return await prisma.unit.update({
      where: { unitId: id },
      data: {
        ...(data.unitName && { unitName: data.unitName }),
        ...(data.unitType && { unitType: data.unitType }),
        ...(data.status && { status: data.status }),
      },
    });
  }

  async delete(id: string) {
    return await prisma.unit.delete({
      where: { unitId: id },
    });
  }

  async hasActiveDeployments(id: string) {
    const count = await prisma.incidentUnit.count({
      where: {
        unitId: id,
        incident: { status: { in: ["OPEN", "ACTIVE"] } },
      },
    });
    return count > 0;
  }
}
