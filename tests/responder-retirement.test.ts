import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ database: vi.fn(), incident: vi.fn(), task: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: calls.database } }));
vi.mock('@/lib/events', () => ({ publishEmergencyEvent: vi.fn() }));
vi.mock('@/lib/jobs', () => ({ enqueueNotification: vi.fn() }));
vi.mock('@/repositories/task.repository', () => ({ TaskRepository: class { findIncidentById = calls.incident; findById = calls.task; } }));
vi.mock('@/middlewares/auth-middleware', () => ({ AuthMiddleware: class { execute = (req: any, _res: any, next: any) => { req.user = { role: 'ADMIN' }; next(); }; } }));
import router from '@/routes/responder.routes';
import { CreateTaskService } from '@/services/task/create-task-service';
import { UpdateTaskService } from '@/services/task/update-task-service';
import { createTaskSchema } from '@/schema/task/create-task.schema';
import { updateTaskSchema } from '@/schema/task/update-task.schema';
beforeEach(() => vi.clearAllMocks());
it('tombstones every old responder CRUD method without database writes', async () => {
  const app = express().use('/responders', router);
  for (const path of ['/responders/v1/', '/responders/v1/synthetic']) {
    for (const method of ['get', 'post', 'put', 'delete'] as const) await request(app)[method](path).expect(410);
  }
  expect(calls.database).not.toHaveBeenCalled();
});
it('rejects new responder assignments before looking up incidents or mutating history', async () => {
  expect((await CreateTaskService('incident', { taskName: 'Synthetic task', assignedTo: 'legacy' } as never)).code).toBe(400);
  expect((await UpdateTaskService('task', { assignedTo: 'legacy' } as never, 'admin', 'ADMIN')).code).toBe(400);
  expect(calls.incident).not.toHaveBeenCalled();
  expect(calls.task).not.toHaveBeenCalled();
  expect(calls.database).not.toHaveBeenCalled();
});
it('denies direct responder task updates before reading private records', async () => {
  expect((await UpdateTaskService('task', { status: 'IN_PROGRESS' }, 'retired', 'RESPONDER')).code).toBe(403);
  expect(calls.task).not.toHaveBeenCalled();
  expect(calls.database).not.toHaveBeenCalled();
});
it('retains omitted historical assignments while rejecting non-null new assignments', () => {
  const params = { id: '11111111-1111-4111-8111-111111111111' };
  expect(createTaskSchema.safeParse({ body: { taskName: 'Synthetic task' } }).success).toBe(true);
  expect(createTaskSchema.safeParse({ body: { taskName: 'Synthetic task', assignedTo: params.id } }).success).toBe(false);
  expect(updateTaskSchema.parse({ params, body: { status: 'IN_PROGRESS' } }).body).not.toHaveProperty('assignedTo');
  expect(updateTaskSchema.safeParse({ params, body: { assignedTo: params.id } }).success).toBe(false);
});
