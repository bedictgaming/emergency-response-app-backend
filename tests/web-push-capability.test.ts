import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '@/app';

describe('web push capability', () => {
  it('exposes only public capability data without requiring a session', async () => {
    const response = await request(app)
      .get('/api/notifications/v1/web-push-key')
      .expect(200);

    expect(response.body).toMatchObject({
      code: 200,
      status: 'success',
      data: { enabled: expect.any(Boolean) },
    });
    expect(response.body.data.publicKey === null || typeof response.body.data.publicKey === 'string').toBe(true);
  });

  it('still requires authentication to register a subscription', async () => {
    await request(app)
      .post('/api/notifications/v1/device-token')
      .send({ token: 'x'.repeat(30), platform: 'web' })
      .expect(401);
  });
});
