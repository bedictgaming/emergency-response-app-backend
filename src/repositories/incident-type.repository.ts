import { prisma } from "@/lib/prisma";

interface CreateIncidentTypeData {
  typeName: string;
  description?: string;
}

interface UpdateIncidentTypeData {
  typeName?: string;
  description?: string;
}

export class IncidentTypeRepository {
  async findAll() {
    return await prisma.incidentType.findMany({
      orderBy: { typeName: "asc" },
      include: {
        _count: { select: { incidents: true } },
      },
    });
  }

  async findById(id: string) {
    return await prisma.incidentType.findUnique({
      where: { typeId: id },
      include: {
        _count: { select: { incidents: true } },
      },
    });
  }

  async findByName(typeName: string) {
    return await prisma.incidentType.findUnique({
      where: { typeName },
    });
  }

  async create(data: CreateIncidentTypeData) {
    return await prisma.incidentType.create({
      data: {
        typeName: data.typeName,
        description: data.description,
      },
    });
  }

  async update(id: string, data: UpdateIncidentTypeData) {
    return await prisma.incidentType.update({
      where: { typeId: id },
      data: {
        ...(data.typeName && { typeName: data.typeName }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });
  }

  async delete(id: string) {
    return await prisma.incidentType.delete({
      where: { typeId: id },
    });
  }

  async hasLinkedIncidents(id: string) {
    const count = await prisma.incident.count({
      where: { typeId: id },
    });
    return count > 0;
  }
}
