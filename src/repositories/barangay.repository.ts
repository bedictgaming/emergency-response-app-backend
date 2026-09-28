import { prisma } from "@/lib/prisma";
import { BarangayStatus, Prisma } from "@/generated/prisma";

export class BarangayRepository {
  async findAll() {
    return await prisma.barangay.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: { incidents: true },
        },
      },
    });
  }

  async findById(barangayId: string) {
    return await prisma.barangay.findUnique({
      where: { barangayId },
      include: {
        _count: {
          select: { incidents: true },
        },
      },
    });
  }

  async findByName(name: string) {
    return await prisma.barangay.findUnique({
      where: { name },
    });
  }

  async findIncidentsByBarangayId(barangayId: string, scope: Prisma.IncidentWhereInput) {
    return await prisma.incident.findMany({
      where: { barangayId, AND: [scope] },
      include: {
        type: true,
        location: true,
        reporter: {
          select: { id: true, name: true, email: true, role: true },
        },
        incidentUnits: {
          include: { unit: true },
        },
      },
      orderBy: { reportedAt: "desc" },
    });
  }

  async updateStatus(barangayId: string, status: BarangayStatus) {
    return await prisma.barangay.update({
      where: { barangayId },
      data: { status },
    });
  }
}
