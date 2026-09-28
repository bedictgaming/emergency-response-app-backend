/* One authentication flow serves every role. Authorization is derived from
   the current database-backed role, department and main-admin assignment. */

import { NextFunction, Request, Response } from "express";
import { verifyAccessToken, JwtPayload } from "@/lib/jwt";
import { prisma } from "@/lib/prisma";
import { hasValidOperationalAssignment, permissionsForActor } from "@/lib/permissions";

type AuthenticatedRequest = Request & { user?: JwtPayload };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSIENT_DATABASE_CODES = new Set([
  "ECONNRESET", // socket closed during TLS handshake or a query
  "ETIMEDOUT", // remote network timeout
  "EAI_AGAIN", // temporary DNS failure
  "P1001", // database server unreachable
  "P1002", // database server timeout
  "P1008", // operation timeout
  "P1017", // server closed the connection
  "P2024", // connection pool timeout
  "P2034", // transaction conflict/deadlock
]);

type PrismaLikeError = Error & { code?: string };

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function isTransientDatabaseError(error: unknown): boolean {
  const prismaError = error as PrismaLikeError;
  if (prismaError?.code && TRANSIENT_DATABASE_CODES.has(prismaError.code)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /can't reach database server|connection (?:reset|terminated|closed)|network socket disconnected|secure tls connection|econnreset|etimedout|timed out/i.test(
    message,
  );
}

async function findActiveAccount(userId: string, sessionId: string) {
  const query = () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, role: true, status: true, department: true, isMainAdmin: true,
        tokens: {
          where: { id: sessionId, type: "REFRESH", consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
          select: { id: true },
          take: 1,
        },
      },
    });

  try {
    return await query();
  } catch (error) {
    if (!isTransientDatabaseError(error)) throw error;
    await wait(100);
    return query();
  }
}

export class AuthMiddleware {
  public execute = async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    
    // 1. Try to get token from Authorization Header
    let accessToken = this.extractBearerToken(req.headers.authorization);

    // 2. Fallback to Cookies (for Web applications)
    if (!accessToken && req.cookies) {
      accessToken = req.cookies.accessToken;
    }

    if (!accessToken) {
      return res.status(401).json({ code: 401, status: "error", message: "Authentication required" });
    }

    const payload = verifyAccessToken(accessToken);
    if (!payload) {
      return res.status(401).json({ code: 401, status: "error", message: "Invalid or expired token" });
    }

    // User IDs are UUIDs in PostgreSQL. Reject a malformed/stale token before
    // Prisma sends a value that PostgreSQL cannot cast to uuid.
    if (!UUID_PATTERN.test(payload.sub) || !payload.sessionId || !UUID_PATTERN.test(payload.sessionId)) {
      return res.status(401).json({
        code: 401,
        status: "error",
        message: "Invalid access token subject",
      });
    }

    let account;
    try {
      account = await findActiveAccount(payload.sub, payload.sessionId);
    } catch (error) {
      const databaseError = error as PrismaLikeError;
      if (isTransientDatabaseError(error)) {
        req.log?.warn(
          { prismaCode: databaseError?.code },
          "Authentication account lookup temporarily unavailable",
        );
      } else {
        req.log?.error(
          { err: error, prismaCode: databaseError?.code },
          "Authentication account lookup failed",
        );
      }
      res.setHeader("Retry-After", "2");
      return res.status(503).json({
        code: 503,
        status: "error",
        message: "Authentication service is temporarily unavailable. Please retry.",
      });
    }

    if (!account || account.status !== "ACTIVE") {
      return res.status(403).json({ code: 403, status: "error", message: "Account is inactive or unavailable" });
    }

    if (account.tokens.length !== 1) {
      return res.status(401).json({ code: 401, status: "error", message: "Session has expired or was revoked" });
    }

    if (!hasValidOperationalAssignment(account)) {
      return res.status(403).json({
        code: 403,
        status: "error",
        message: "Operational account is missing an authorized department assignment",
      });
    }

    authReq.user = {
      ...payload,
      role: account.role,
      department: account.department,
      isMainAdmin: account.isMainAdmin,
      permissions: permissionsForActor(account),
    };
    return next();
  };

  private extractBearerToken(header?: string) {
    if (!header) return undefined;
    const [scheme, token] = header.split(" ");
    if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return undefined;
    return token.trim();
  }
}
