import { Router } from "express";
import { AlertController } from "@/controllers/alert.controller";
import { validateSchema } from "@/middleware/validate.schema";
import { createAlertSchema } from "@/validation/alert";
import { listAlertsSchema, readAlertSchema } from "@/validation/alert/read-alert.schema";
import { AuthMiddleware } from "@/middleware/auth-middleware";
import { permittedRole, requireMainAdmin } from "@/middleware/rbac-middleware";
import { Role } from "@/generated/prisma";
import { requireTargetIncidentDepartment } from "@/middleware/operational-access-middleware";

// Initialize
const router = Router();
const alertController = new AlertController();
const authMiddleware = new AuthMiddleware();

// Public Routes — view broadcast alerts
router.get("/v1/", validateSchema(listAlertsSchema), alertController.getAll);
router.get("/v1/:id", validateSchema(readAlertSchema), alertController.getById);

// Dispatch alert — any authenticated dispatcher/admin
router.post(
  "/v1/",
  authMiddleware.execute,
  permittedRole([Role.ADMIN, Role.DISPATCHER]),
  validateSchema(createAlertSchema),
  requireTargetIncidentDepartment,
  alertController.create
);

// Delete alert — ADMIN only
router.delete(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  requireMainAdmin,
  validateSchema(readAlertSchema),
  alertController.delete
);

export default router;
