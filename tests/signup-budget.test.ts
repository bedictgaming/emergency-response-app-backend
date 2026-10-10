import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
vi.mock('@/controllers/auth.controller', () => ({ AuthController: class {
  signup = (_: unknown, res: express.Response) => res.status(200).json({ status: 'success' });
  login = this.signup; verifyEmail = this.signup; refresh = this.signup;
  logout = this.signup; googleCallback = this.signup; me = this.signup;
  requestPasswordReset = this.signup; resetPassword = this.signup;
  loginMethods = this.signup; linkGoogle = this.signup; unlinkGoogle = this.signup;
} }));
vi.mock('@/lib/passport', () => ({ default: { authenticate: () => (_: unknown, __: unknown, next: () => void) => next() } }));
import router from '@/routes/auth.routes';
const app = express(); app.use(express.json(), router);
it('counts successful registrations and reset requests while resend remains removed', async () => {
  for (let index = 0; index < 10; index++) {
    await request(app).post('/v1/signup').send({ name: 'Citizen', email: `citizen${index}@example.test`, password: 'StrongPassword123' }).expect(200);
  }
  await request(app).post('/v1/signup').send({ name: 'Citizen', email: 'extra@example.test', password: 'StrongPassword123' }).expect(429);
  await request(app).post('/v1/resend-email-verification').send({ email: 'citizen@example.test' }).expect(404);
  await request(app).post('/v1/password-reset/request').send({ email: 'citizen@example.test' }).expect(429);
});
