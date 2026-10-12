import { vi } from 'vitest';
import type { JwtPayload } from '@/lib/jwt';

export const operationalAccount = (actor: JwtPayload) => ({
  role: actor.role, department: actor.department, isMainAdmin: actor.isMainAdmin ?? false,
  status: 'ACTIVE', tokens: [{ id: actor.sessionId }],
});
export const operationalUserMock = (actor: JwtPayload) => ({ findUnique: vi.fn().mockResolvedValue(operationalAccount(actor)) });
