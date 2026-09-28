import { prisma } from "@/lib/prisma";
import { Prisma, ResponderStatus } from "@/generated/prisma";

interface CreateResponderData {
  userId: string;
  unitId: string;
  rank?: string;
  certifications?: string;
  status?: ResponderStatus;
}

interface UpdateResponderData {
  unitId?: string;
  rank?: string;
  certifications?: string;
  status?: ResponderStatus;
}

interface ResponderFilters {
  unitId?: string;
  status?: ResponderStatus;
  unitScope?: Prisma.UnitWhereInput;
  userId?: string;
}

export class ResponderRepository {
  async findAll(filters?: ResponderFilters) {
    return await prisma.responder.findMany({
      where: {
        ...(filters?.unitId && { unitId: filters.unitId }),
        ...(filters?.status && { status: filters.status }),
        ...(filters?.unitScope && { unit: filters.unitScope }),
        ...(filters?.userId && { userId: filters.userId }),
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
        unit: {
          select: { unitId: true, unitName: true, unitType: true, status: true },
        },
        _count: { select: { tasks: true } },
      },
      orderBy: { status: "asc" },
    });
  }

  async findById(id: string) {
    return await prisma.responder.findUnique({
      where: { responderId: id },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
        unit: {
          select: {
            unitId: true,
            unitName: true,
            unitType: true,
            status: true,
          },
        },
        tasks: {
          include: {
            incident: {
              select: {
                incidentId: true,
                title: true,
                status: true,
                severityLevel: true,
              },
            },
          },
          orderBy: [{ priority: "desc" }, { dueAt: "asc" }],
        },
      },
    });
  }

  async findByUserId(userId: string) {
    return await prisma.responder.findUnique({
      where: { userId },
    });
  }

  async findUserById(userId: string) {
    return await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true },
    });
  }

  async findUnitById(unitId: string) {
    return await prisma.unit.findUnique({
      where: { unitId },
    });
  }

  async create(data: CreateResponderData) {
    return await prisma.responder.create({
      data: {
        userId: data.userId,
        unitId: data.unitId,
        rank: data.rank,
        certifications: data.certifications,
        status: data.status ?? ResponderStatus.AVAILABLE,
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
        unit: {
          select: { unitId: true, unitName: true, unitType: true, status: true },
        },
      },
    });
  }

  async update(id: string, data: UpdateResponderData) {
    return await prisma.responder.update({
      where: { responderId: id },
      data: {
        ...(data.unitId && { unitId: data.unitId }),
        ...(data.rank !== undefined && { rank: data.rank }),
        ...(data.certifications !== undefined && {
          certifications: data.certifications,
        }),
        ...(data.status && { status: data.status }),
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
        unit: {
          select: { unitId: true, unitName: true, unitType: true, status: true },
        },
      },
    });
  }

  async delete(id: string) {
    return await prisma.responder.delete({
      where: { responderId: id },
    });
  }

  async hasActiveTasks(id: string) {
    const count = await prisma.task.count({
      where: {
        assignedTo: id,
        status: { in: ["PENDING", "IN_PROGRESS"] },
      },
    });
    return count > 0;
  }
}
