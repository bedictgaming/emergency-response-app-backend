import { Router } from 'express';
import { AuthMiddleware } from '@/middleware/auth-middleware';
import { permittedRole } from '@/middleware/rbac-middleware';
import { Role } from '@/generated/prisma';
import { retiredUnitWorkflow } from '@/middleware/retired-unit-workflow';

// Authenticated compatibility boundary only; historical schema/data remain.
const router = Router();
router.use(new AuthMiddleware().execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), retiredUnitWorkflow);
export default router;
