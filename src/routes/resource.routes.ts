import { Router } from "express";
import { ResourceController } from "@/controllers/resource.controller";
import { validateSchema } from "@/middlewares/validate.schema";
import { createResourceSchema, updateResourceSchema } from "@/schema/resource";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { permittedRole } from "@/middlewares/rbac-middleware";
import { Role } from "@/generated/prisma";
import { requireResourceDepartment, requireTargetUnitDepartment } from "@/middlewares/operational-access-middleware";

// Initialize
const router = Router();
const resourceController = new ResourceController();
const authMiddleware = new AuthMiddleware();

// Authenticated Routes — view resources
router.get("/v1/", authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), resourceController.getAll);
router.get("/v1/:id", authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), requireResourceDepartment, resourceController.getById);

// Protected Routes — ADMIN only (resource management)
router.post(
  "/v1/",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  validateSchema(createResourceSchema),
  requireTargetUnitDepartment,
  resourceController.create
);

router.put(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  validateSchema(updateResourceSchema),
  requireResourceDepartment,
  requireTargetUnitDepartment,
  resourceController.update
);

router.delete(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  requireResourceDepartment,
  resourceController.delete
);

export default router;
