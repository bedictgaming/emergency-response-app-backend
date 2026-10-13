import { Router } from 'express';
import { AuthMiddleware } from '@/middleware/auth-middleware';
import { permittedRole } from '@/middleware/rbac-middleware';
import { Role } from '@/generated/prisma';

const router = Router();
// Preserve historical personnel rows, but retire all old CRUD endpoints.
router.use(new AuthMiddleware().execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), (_req, res) => {
  res.status(410).json({ code: 410, status: 'error', message: 'Responder management has been retired. Units and dispatch remain available.' });
});
export default router;
