import { prisma } from "@/lib/prisma";

export class OAuthAccountRepository {
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
