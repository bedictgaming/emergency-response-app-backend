import { Router } from "express";
import { UnitController } from "@/controllers/unit.controller";
import { ResourceController } from "@/controllers/resource.controller";
import { validateSchema } from "@/middlewares/validate.schema";
import { createUnitSchema, updateUnitSchema } from "@/schema/unit";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { permittedRole } from "@/middlewares/rbac-middleware";
import { Role } from "@/generated/prisma";
import { requireTargetUnitDepartment, requireUnitDepartment } from "@/middlewares/operational-access-middleware";

// Initialize
const router = Router();
const unitController = new UnitController();
const resourceController = new ResourceController();
const authMiddleware = new AuthMiddleware();

// Authenticated Routes — any logged-in user can view units
router.get("/v1/", authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), unitController.getAll);
router.get("/v1/:id", authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), requireUnitDepartment, unitController.getById);

// Nested Resource Routes — GET /units/v1/:unitId/resources
router.get(
  "/v1/:unitId/resources",
  authMiddleware.execute,
  permittedRole([Role.ADMIN, Role.DISPATCHER]),
  requireUnitDepartment,
  resourceController.getByUnit
);

// Protected Routes — ADMIN only (unit roster management)
router.post(
  "/v1/",
  authMiddleware.execute,
  permittedRole([Role.ADMIN, Role.DISPATCHER]),
  validateSchema(createUnitSchema),
  requireTargetUnitDepartment,
  unitController.create
);

router.put(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN, Role.DISPATCHER]),
  validateSchema(updateUnitSchema),
  requireUnitDepartment,
  requireTargetUnitDepartment,
  unitController.update
);

router.delete(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  requireUnitDepartment,
  unitController.delete
);

export default router;
