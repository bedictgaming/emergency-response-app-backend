import { prisma } from "@/lib/prisma";

export class OAuthAccountRepository {
  // Nested creation is atomic: a provider/email collision cannot leave an
  // orphan user. No existing user is connected and Prisma's USER default applies.
  async createUserWithAccount(data: { providerAccountId: string; name: string | null; email: string }) {
    return prisma.authIdentity.create({
      data: {
        provider: "google", providerUserId: data.providerAccountId, email: data.email,
        user: { create: { name: data.name, email: data.email, emailVerified: new Date() } },
      },
      select: { userId: true },
    });
  }

  async findByProvider(provider: string, providerAccountId: string) {
    return prisma.authIdentity.findUnique({
      where: {
        provider_providerUserId: { provider, providerUserId: providerAccountId },
      },
    });
  }

  async create(data: { provider: string; providerAccountId: string; userId: string }) {
    return prisma.authIdentity.create({ data: { provider: data.provider, providerUserId: data.providerAccountId, userId: data.userId } });
  }
}
