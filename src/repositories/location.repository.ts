import { prisma } from "@/lib/prisma";

interface CreateLocationData {
  locationName: string;
  address?: string;
  city?: string;
  province?: string;
  latitude?: number;
  longitude?: number;
}

interface UpdateLocationData {
  locationName?: string;
  address?: string;
  city?: string;
  province?: string;
  latitude?: number;
  longitude?: number;
}

export class LocationRepository {
  async findAll() {
    return await prisma.location.findMany({
      orderBy: { locationName: "asc" },
    });
  }

  async findById(id: string) {
    return await prisma.location.findUnique({
      where: { locationId: id },
    });
  }

  async create(data: CreateLocationData) {
    return await prisma.location.create({
      data: {
        locationName: data.locationName,
        address: data.address,
        city: data.city,
        province: data.province,
        latitude: data.latitude,
        longitude: data.longitude,
      },
    });
  }

  async update(id: string, data: UpdateLocationData) {
    return await prisma.location.update({
      where: { locationId: id },
      data: {
        locationName: data.locationName,
        address: data.address,
        city: data.city,
        province: data.province,
        latitude: data.latitude,
        longitude: data.longitude,
      },
    });
  }

  async delete(id: string) {
    return await prisma.location.delete({
      where: { locationId: id },
    });
  }

  async referenceCount(id: string) {
    const [incidents, alerts] = await Promise.all([
      prisma.incident.count({ where: { locationId: id } }),
      prisma.alert.count({ where: { locationId: id } }),
    ]);
    return incidents + alerts;
  }
}
