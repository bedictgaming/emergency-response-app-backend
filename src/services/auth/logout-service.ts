import { TokenRepository } from '@/repositories/token.repository';

const tokens = new TokenRepository();

// Revoke first; a persistence failure must not be reported as successful logout.
// Cookie clearing remains the HTTP controller's responsibility.
export async function LogoutService(refreshToken: unknown): Promise<void> {
  if (typeof refreshToken === 'string') await tokens.revokeRefreshTokenByValue(refreshToken);
}
