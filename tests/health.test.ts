import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '@/app';

describe('service health and headers', () => {
  it('returns health without exposing framework details', async () => {
    const response = await request(app).get('/healthz').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('does not cache live API responses', async () => {
    const response = await request(app).get('/api/route-that-does-not-exist').expect(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.etag).toBeUndefined();
    expect(response.body).toEqual({
      code: 404,
      status: 'error',
      message: 'Cannot GET /api/route-that-does-not-exist',
    });
  });

  it('returns the error envelope for malformed JSON without exposing a stack', async () => {
    const response = await request(app)
      .post('/api/incidents/v1/')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);

    expect(response.body).toEqual({
      code: 400,
      status: 'error',
      message: 'Invalid JSON request body',
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('does not expose incident locations to anonymous clients', async () => {
    await request(app).get('/api/locations/v1/').expect(401);
    await request(app).get('/api/locations/v1/00000000-0000-0000-0000-000000000001').expect(401);
  });

  it('does not trust an unconfigured forwarded address', () => {
    expect(app.get('trust proxy')).toBe(false);
  });
});
