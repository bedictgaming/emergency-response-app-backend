import { describe, expect, it } from 'vitest';
import { backgroundJobRetryDelayMs, isTransientJobInfrastructureError } from '@/lib/background-job-resilience';
import { getHttpLogLevel } from '@/lib/http-log-policy';

describe('operational resilience policy', () => {
  it('recognizes the database and network failures emitted by the worker', () => {
    expect(isTransientJobInfrastructureError({ code: 'ECONNRESET', message: 'read ECONNRESET' })).toBe(true);
    expect(isTransientJobInfrastructureError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientJobInfrastructureError({ code: 'ENOTFOUND' })).toBe(true);
    expect(isTransientJobInfrastructureError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientJobInfrastructureError(new Error('ERROR: Authentication timed out'))).toBe(true);
    expect(isTransientJobInfrastructureError(new Error('Column does not exist'))).toBe(false);
  });

  it('backs off transient worker failures up to five minutes', () => {
    expect(backgroundJobRetryDelayMs(1)).toBe(15_000);
    expect(backgroundJobRetryDelayMs(2)).toBe(30_000);
    expect(backgroundJobRetryDelayMs(3)).toBe(60_000);
    expect(backgroundJobRetryDelayMs(10)).toBe(300_000);
  });

  it('keeps expected authentication expiry out of development warning logs', () => {
    expect(getHttpLogLevel({ method: 'GET', url: '/api/auth/v1/me', statusCode: 401, environment: 'development' })).toBe('silent');
    expect(getHttpLogLevel({ method: 'POST', url: '/api/auth/v1/refresh-token?source=client', statusCode: 401, environment: 'development' })).toBe('silent');
    expect(getHttpLogLevel({ method: 'POST', url: '/api/incidents/v1/nearby-check', statusCode: 401, environment: 'development' })).toBe('silent');
    expect(getHttpLogLevel({ method: 'GET', url: '/api/incidents/v1', statusCode: 500, environment: 'development' })).toBe('error');
  });

  it('keeps expected incident validation responses out of development warning logs', () => {
    expect(getHttpLogLevel({ method: 'POST', url: '/api/incidents/v1/', statusCode: 422, environment: 'development' })).toBe('silent');
    expect(getHttpLogLevel({ method: 'POST', url: '/api/incidents/v1/nearby-check', statusCode: 422, environment: 'development' })).toBe('silent');
  });
});
