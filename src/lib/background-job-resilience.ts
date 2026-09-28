const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'P1001',
  'P1002',
  'P1008',
  'P1017',
]);

const TRANSIENT_MESSAGES = [
  'authentication timed out',
  'connection terminated unexpectedly',
  'connection closed',
  'connection reset',
  'network socket disconnected',
  'secure tls connection',
  'read econnreset',
  'getaddrinfo enotfound',
  'timed out',
  "can't reach database server",
];

const errorDetails = (error: unknown): string => {
  if (!error || typeof error !== 'object') return String(error ?? '');
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  return [candidate.code, candidate.message, candidate.cause, String(error)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
};

export function isTransientJobInfrastructureError(error: unknown): boolean {
  const candidate = error as { code?: unknown } | null;
  if (candidate?.code && TRANSIENT_CODES.has(String(candidate.code).toUpperCase())) return true;
  const details = errorDetails(error);
  return TRANSIENT_MESSAGES.some((message) => details.includes(message));
}

export function backgroundJobRetryDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 5));
  return Math.min(5 * 60_000, 15_000 * (2 ** exponent));
}

