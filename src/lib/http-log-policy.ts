export type HttpLogLevel = 'silent' | 'info' | 'warn' | 'error';

const normalizedPath = (url = '') => {
  const path = url.split('?')[0] || '/';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
};

export function getHttpLogLevel(input: {
  method?: string;
  url?: string;
  statusCode: number;
  hasError?: boolean;
  environment: string;
}): HttpLogLevel {
  const method = (input.method || 'GET').toUpperCase();
  const path = normalizedPath(input.url);
  const development = input.environment === 'development';

  if (input.hasError || input.statusCode >= 500) return 'error';

  // Authentication expiry is an expected client state transition. Production
  // retains it as an informational audit event, while development terminals
  // stay focused on actionable backend faults.
  if (input.statusCode === 401) return development ? 'silent' : 'info';

  const rejectedLogin = method === 'POST'
    && path === '/api/auth/v1/login'
    && input.statusCode === 403;
  if (rejectedLogin) return development ? 'silent' : 'info';

  const expectedIncidentRejection = method === 'POST'
    && ['/api/incidents/v1', '/api/incidents/v1/nearby-check'].includes(path)
    && [409, 422, 429].includes(input.statusCode);
  if (expectedIncidentRejection) return development ? 'silent' : 'info';

  if (input.statusCode >= 400) return 'warn';
  return development ? 'silent' : 'info';
}
