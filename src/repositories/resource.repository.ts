import { prisma } from "@/lib/prisma";
import { Prisma, ResourceStatus } from "@/generated/prisma";

interface CreateResourceData {
  resourceName: string;
  resourceType: string;
  quantity: number;
  status?: ResourceStatus;
  unitId: string;
}

interface UpdateResourceData {
  resourceName?: string;
  resourceType?: string;
  quantity?: number;
  status?: ResourceStatus;
  unitId?: string;
}

interface ResourceFilters {
  unitId?: string;
  status?: ResourceStatus;
  resourceType?: string;
  unitScope?: Prisma.UnitWhereInput;
  responderUserId?: string;
}

export class ResourceRepository {
  async findAll(filters?: ResourceFilters) {
    return await prisma.resource.findMany({
      where: {
        ...(filters?.unitId && { unitId: filters.unitId }),
        ...(filters?.status && { status: filters.status }),
        ...(filters?.resourceType && {
          resourceType: { contains: filters.resourceType, mode: "insensitive" },
        }),
        ...(filters?.unitScope && { unit: filters.unitScope }),
        ...(filters?.responderUserId && { unit: { responders: { some: { userId: filters.responderUserId } } } }),
      },
      include: {
        unit: {
          select: { unitId: true, unitName: true, unitType: true, status: true },
        },
      },
      orderBy: { resourceName: "asc" },
    });
  }

  async findById(id: string) {
    return await prisma.resource.findUnique({
      where: { resourceId: id },
      include: {
        unit: {
          select: { unitId: true, unitName: true, unitType: true, status: true },
        },
      },
    });
  }

  async findByUnitId(unitId: string) {
    return await prisma.resource.findMany({
      where: { unitId },
      include: {
        unit: {
          select: { unitId: true, unitName: true, unitType: true },
        },
      },
      orderBy: { resourceName: "asc" },
    });
  }

  async create(data: CreateResourceData) {
    return await prisma.resource.create({
      data: {
        resourceName: data.resourceName,
        resourceType: data.resourceType,
        quantity: data.quantity,
        status: data.status ?? ResourceStatus.AVAILABLE,
        unitId: data.unitId,
      },
      include: {
        unit: {
          select: { unitId: true, unitName: true, unitType: true },
        },
      },
    });
  }

  async update(id: string, data: UpdateResourceData) {
    return await prisma.resource.update({
      where: { resourceId: id },
      data: {
        ...(data.resourceName && { resourceName: data.resourceName }),
        ...(data.resourceType && { resourceType: data.resourceType }),
        ...(data.quantity !== undefined && { quantity: data.quantity }),
        ...(data.status && { status: data.status }),
        ...(data.unitId && { unitId: data.unitId }),
      },
      include: {
        unit: {
          select: { unitId: true, unitName: true, unitType: true },
        },
      },
    });
  }

  async delete(id: string) {
    return await prisma.resource.delete({
      where: { resourceId: id },
    });
  }

  async findUnitById(unitId: string) {
    return await prisma.unit.findUnique({
      where: { unitId },
    });
  }
}
