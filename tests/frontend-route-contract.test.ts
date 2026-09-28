import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '@/app';

describe('frontend to backend route contract', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const protectedCalls = [
    () => request(app).get('/api/incidents/v1/'),
    () => request(app).post('/api/incidents/v1/'),
    () => request(app).put(`/api/incidents/v1/${id}`),
    () => request(app).patch(`/api/incidents/v1/${id}/verify`),
    () => request(app).delete(`/api/incidents/v1/${id}`),
    () => request(app).get('/api/units/v1/'),
    () => request(app).post(`/api/incidents/v1/${id}/units`),
    () => request(app).put(`/api/incident-units/v1/${id}`),
    () => request(app).get('/api/tasks/v1/'),
    () => request(app).post(`/api/incidents/v1/${id}/tasks`),
    () => request(app).get('/api/resources/v1/'),
    () => request(app).get('/api/responders/v1/'),
    () => request(app).get('/api/users/v1/'),
    () => request(app).get('/api/analytics/v1/dashboard'),
    () => request(app).post('/api/upload/v1/signature'),
    () => request(app).post('/api/notifications/v1/device-token'),
  ];

  it('mounts every protected main-feature endpoint and applies authentication', async () => {
    for (const call of protectedCalls) {
      const response = await call();
      expect(response.status, `${response.request.method} ${response.request.url}`).toBe(401);
      expect(response.body.message).toBe('Authentication required');
    }
  });
});
