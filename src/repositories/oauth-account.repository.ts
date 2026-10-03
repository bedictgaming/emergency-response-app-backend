import { prisma } from "@/lib/prisma";

export class OAuthAccountRepository {
  // Nested creation is atomic: a provider/email collision cannot leave an
  // orphan user. No existing user is connected and Prisma's USER default applies.
  async createUserWithAccount(data: { providerAccountId: string; name: string | null; email: string }) {
    return prisma.oAuthAccount.create({
      data: {
        provider: "google", providerAccountId: data.providerAccountId,
        user: { create: { name: data.name, email: data.email, emailVerified: new Date() } },
      },
      select: { userId: true },
    });
  }

  async findByProvider(provider: string, providerAccountId: string) {
    return prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: { provider, providerAccountId },
      },
    });
  }

  async create(data: { provider: string; providerAccountId: string; userId: string }) {
    return prisma.oAuthAccount.create({ data });
  }
}
