import { prisma } from "@/lib/prisma";
import { Department, Role, UserStatus } from "@/generated/prisma";
import { randomUUID } from "node:crypto";

interface UserFilters {
  role?: Role;
  search?: string;
}

export class UserRepository {
  async findById(id: string) {
    return await prisma.user.findFirst({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        updatedAt: true,
        role: true,
        department: true,
        isMainAdmin: true,
        status: true,
        emailVerified: true,
      },
    });
  }

  async findDetailById(id: string) {
    return await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        isMainAdmin: true,
        status: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
        responder: {
          include: {
            unit: true,
          },
        },
        _count: {
          select: {
            reportedIncidents: true,
            uploadedFiles: true,
            sentAlerts: true,
          },
        },
      },
    });
  }

  async findAll(filters?: UserFilters) {
    return await prisma.user.findMany({
      where: {
        ...(filters?.role && { role: filters.role }),
        ...(filters?.search && {
          OR: [
            { name: { contains: filters.search, mode: "insensitive" } },
            { email: { contains: filters.search, mode: "insensitive" } },
          ],
        }),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        isMainAdmin: true,
        status: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
        responder: {
          select: {
            responderId: true,
            rank: true,
            status: true,
            unit: {
              select: { unitId: true, unitName: true, unitType: true },
            },
          },
        },
        _count: {
          select: {
            reportedIncidents: true,
            uploadedFiles: true,
            sentAlerts: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findByEmail(email: string) {
    return await prisma.user.findFirst({
      where: { email: { equals: email.trim(), mode: "insensitive" } },
    });
  }

  async create(data: {
    name?: string | null;
    email?: string | null;
    password?: string | null;
    emailVerified?: Date | null;
  }) {
    const id = randomUUID();
    return await prisma.user.create({
      data: { ...data, id, ...(data.password ? { authIdentities: { create: {
        provider: "password", providerUserId: id, email: data.email,
      } } } : {}) },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        updatedAt: true,
        role: true,
        emailVerified: true,
      },
    });
  }

  async updateRole(id: string, role: Role, department?: Department | null, isMainAdmin = false) {
    return await prisma.user.update({
      where: { id },
      data: { role, department: role === Role.ADMIN || role === Role.DISPATCHER ? department : null, isMainAdmin: role === Role.ADMIN && isMainAdmin },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        isMainAdmin: true,
        updatedAt: true,
      },
    });
  }

  async updateStatus(id: string, status: UserStatus) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: { status },
        select: { id: true, name: true, email: true, role: true, status: true, updatedAt: true },
      });
      if (status === UserStatus.INACTIVE) {
        await tx.token.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.responder.updateMany({
          where: { userId: id },
          data: { status: "OFF_DUTY" },
        });
      }
      return user;
    });
  }

  async delete(id: string) {
    return await prisma.user.delete({
      where: { id },
    });
  }

  async markEmailVerified(userId: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { emailVerified: new Date() },
      select: { id: true, email: true, emailVerified: true },
    });
  }
}
