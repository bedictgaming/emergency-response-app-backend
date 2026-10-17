import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => ({ WEB_PUSH_PUBLIC_KEY: '', WEB_PUSH_PRIVATE_KEY: '', BACKGROUND_JOBS_ENABLED: false }));
vi.mock('@/config/env', () => ({ ENV: settings }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
import router from '@/routes/notification.routes';
const app = express(); app.use(router);
beforeEach(() => Object.assign(settings, { WEB_PUSH_PUBLIC_KEY: '', WEB_PUSH_PRIVATE_KEY: '', BACKGROUND_JOBS_ENABLED: false }));
it('reports unconfigured push without exposing server-only settings', async () => {
  const response = await request(app).get('/v1/web-push-key').expect(200);
  expect(response.body.data).toEqual({ enabled: false, publicKey: null, reason: 'not-configured' });
});
it('does not advertise delivery readiness while the background worker is disabled', async () => {
  Object.assign(settings, { WEB_PUSH_PUBLIC_KEY: 'synthetic-public', WEB_PUSH_PRIVATE_KEY: 'synthetic-private' });
  const response = await request(app).get('/v1/web-push-key').expect(200);
  expect(response.body.data).toEqual({ enabled: false, publicKey: null, reason: 'worker-disabled' });
});
it('reports configured capability only when keys and worker are enabled', async () => {
  Object.assign(settings, { WEB_PUSH_PUBLIC_KEY: 'synthetic-public', WEB_PUSH_PRIVATE_KEY: 'synthetic-private', BACKGROUND_JOBS_ENABLED: true });
  const response = await request(app).get('/v1/web-push-key').expect(200);
  expect(response.body.data).toEqual({ enabled: true, publicKey: 'synthetic-public', reason: null });
  expect(JSON.stringify(response.body)).not.toContain('synthetic-private');
});
