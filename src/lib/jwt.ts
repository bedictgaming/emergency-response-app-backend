import jwt, { SignOptions } from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { ENV } from "@/config/env";
import type { Department } from "@/generated/prisma";
import type { PermissionName } from "@/lib/permissions";

export type JwtPayload = { sub: string; role: string; type: "access" | "refresh"; sessionId?: string; department?: Department | null; isMainAdmin?: boolean; permissions?: PermissionName[] };
const jwtSecret = ENV.JWT_SECRET;

export enum TokenExpiry {
  ACCESS_TOKEN_EXPIRES = "15m",
  REFRESH_TOKEN_EXPIRES = "7d",
}

export function signAccessToken(userId: string, role: string, duration: SignOptions["expiresIn"], sessionId: string) {
  const payload: JwtPayload = { sub: userId, role, type: "access", sessionId };
  return jwt.sign(payload, jwtSecret, { expiresIn: duration });
}

export function signRefreshToken(userId: string, role: string, duration: SignOptions["expiresIn"]) {
  const payload: JwtPayload = { sub: userId, role, type: "refresh" };
  return jwt.sign(payload, jwtSecret, { expiresIn: duration, jwtid: randomUUID() });
}

export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, jwtSecret) as JwtPayload;
    return payload.type === "access" ? payload : null;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, jwtSecret) as JwtPayload;
    return payload.type === "refresh" ? payload : null;
  } catch {
    return null;
  }
}


export function toMilliseconds(duration?: string | number) {
  if (duration === undefined) return undefined;
  if (typeof duration === "number") {
    return duration * 1000;
  }

  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) return undefined;

  const value = Number(match[1]);
  const unit = match[2];

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return undefined;
  }
}
