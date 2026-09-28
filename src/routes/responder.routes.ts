import { Router } from "express";
import { ResponderController } from "@/controllers/responder.controller";
import { validateSchema } from "@/middlewares/validate.schema";
import { createResponderSchema, updateResponderSchema } from "@/schema/responder";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { permittedRole } from "@/middlewares/rbac-middleware";
import { Role } from "@/generated/prisma";
import { requireMainAdmin } from "@/middlewares/rbac-middleware";
import { requireResponderDepartment, requireTargetUnitDepartment } from "@/middlewares/operational-access-middleware";

// Initialize
const router = Router();
const responderController = new ResponderController();
const authMiddleware = new AuthMiddleware();

// Authenticated Routes — view responder personnel
router.get("/v1/", authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER, Role.RESPONDER]), responderController.getAll);
router.get("/v1/:id", authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER, Role.RESPONDER]), requireResponderDepartment, responderController.getById);

// Protected Routes — ADMIN only to link responder or delete
router.post(
  "/v1/",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  validateSchema(createResponderSchema),
  requireMainAdmin,
  requireTargetUnitDepartment,
  responderController.create
);

router.put(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  validateSchema(updateResponderSchema),
  requireResponderDepartment,
  requireTargetUnitDepartment,
  responderController.update
);

router.delete(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  requireMainAdmin,
  requireResponderDepartment,
  responderController.delete
);

export default router;
