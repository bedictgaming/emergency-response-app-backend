import { prisma } from "@/lib/prisma";
import { AlertType, AlertSeverity } from "@/generated/prisma";

interface CreateAlertData {
  alertType: AlertType;
  message: string;
  severity?: AlertSeverity;
  incidentId?: string;
  locationId?: string;
  sentBy: string;
}

interface AlertFilters {
  alertType?: AlertType;
  severity?: AlertSeverity;
  incidentId?: string;
  locationId?: string;
}

export class AlertRepository {
  async findAll(filters?: AlertFilters) {
    return await prisma.alert.findMany({
      where: {
        ...(filters?.alertType && { alertType: filters.alertType }),
        ...(filters?.severity && { severity: filters.severity }),
        ...(filters?.incidentId && { incidentId: filters.incidentId }),
        ...(filters?.locationId && { locationId: filters.locationId }),
      },
      select: { alertId: true, alertType: true, message: true, severity: true, sentAt: true },
      orderBy: { sentAt: "desc" },
      take: 50,
    });
  }

  async findById(id: string) {
    return await prisma.alert.findUnique({
      where: { alertId: id },
      select: { alertId: true, alertType: true, message: true, severity: true, sentAt: true },
    });
  }

  async create(data: CreateAlertData) {
    return await prisma.alert.create({
      data: {
        alertType: data.alertType,
        message: data.message,
        severity: data.severity ?? AlertSeverity.INFO,
        incidentId: data.incidentId,
        locationId: data.locationId,
        sentBy: data.sentBy,
      },
      include: {
        sender: {
          select: { id: true, name: true, email: true, role: true },
        },
        incident: {
          select: { incidentId: true, title: true, status: true },
        },
        location: {
          select: { locationId: true, locationName: true },
        },
      },
    });
  }

  async delete(id: string) {
    return await prisma.alert.delete({
      where: { alertId: id },
    });
  }

  async findIncidentById(incidentId: string) {
    return await prisma.incident.findUnique({
      where: { incidentId },
    });
  }

  async findLocationById(locationId: string) {
    return await prisma.location.findUnique({
      where: { locationId },
    });
  }
}
