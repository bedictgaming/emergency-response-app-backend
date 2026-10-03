import { prisma } from "@/lib/prisma";
import crypto from "node:crypto";
import { TokenType } from "@/generated/prisma";
import type { Token } from "@/generated/prisma/client";

export class TokenRepository {
  // Persist cooldown claims without invalidating a still-valid email link.
  async claimVerificationResend(userId: string, now = new Date()) {
    return prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.emailVerified || user.status !== "ACTIVE") return null;
      const latest = await tx.token.findFirst({ where: { userId, type: TokenType.EMAIL_VERIFY }, orderBy: { createdAt: "desc" } });
      if (latest && now.getTime() - latest.createdAt.getTime() < 60_000) return null;
      const valid = await tx.token.findFirst({ where: { userId, type: TokenType.EMAIL_VERIFY, consumedAt: null, revokedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
      if (valid) {
        // This revoked, expired token is a resend-attempt marker, never a link.
        await tx.token.create({ data: { userId, type: TokenType.EMAIL_VERIFY, token: crypto.randomUUID(), expiresAt: now, revokedAt: now } });
        return { user, token: valid };
      }
      await tx.token.updateMany({ where: { userId, type: TokenType.EMAIL_VERIFY, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      const token = await tx.token.create({ data: { userId, type: TokenType.EMAIL_VERIFY, token: crypto.randomUUID(), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
      return { user, token };
    });
  }
  async createEmailVerificationToken(params: { userId: string; token: string; expiresAt: Date }) {
    const { userId, token, expiresAt } = params;
    return prisma.token.create({
      data: {
        userId,
        token,
        expiresAt,
        type: TokenType.EMAIL_VERIFY,
      },
    });
  }

  async createRefreshToken(params: { userId: string; token: string; expiresAt: Date }) {
    const { userId, token, expiresAt } = params;
    return prisma.token.create({
      data: {
        userId,
        token,
        expiresAt,
        type: TokenType.REFRESH,
      },
    });
  }

  async findActiveRefreshToken(token: string): Promise<Token | null> {
    return prisma.token.findFirst({
      where: {
        token,
        type: TokenType.REFRESH,
        consumedAt: null,
        revokedAt: null,
      },
    });
  }


  async findActiveEmailVerificationToken(token: string): Promise<Token | null> {
    return prisma.token.findFirst({
      where: {
        token,
        type: TokenType.EMAIL_VERIFY,
        consumedAt: null,
        revokedAt: null,
      },
    });
  }

  async findLatestEmailVerificationTokenByUser(userId: string): Promise<Token | null> {
    return prisma.token.findFirst({
      where: {
        userId,
        type: TokenType.EMAIL_VERIFY,
        consumedAt: null,
        revokedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async consumeToken(id: string) {
    return prisma.token.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  }

  async revokeToken(id: string) {
    return prisma.token.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }
}
