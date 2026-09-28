import { Router } from "express";
import { IncidentTypeController } from "@/controllers/incident-type.controller";
import { validateSchema } from "@/middlewares/validate.schema";
import { createIncidentTypeSchema, updateIncidentTypeSchema } from "@/schema/incident-type";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { permittedRole, requireMainAdmin } from "@/middlewares/rbac-middleware";
import { Role } from "@/generated/prisma";

// Initialize
const router = Router();
const incidentTypeController = new IncidentTypeController();
const authMiddleware = new AuthMiddleware();

// Public Routes — any authenticated user can view reference data
router.get("/v1/", authMiddleware.execute, incidentTypeController.getAll);
router.get("/v1/:id", authMiddleware.execute, incidentTypeController.getById);

// Protected Routes — ADMIN only (reference/lookup table managed by admin)
router.post(
  "/v1/",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  requireMainAdmin,
  validateSchema(createIncidentTypeSchema),
  incidentTypeController.create
);

router.put(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  requireMainAdmin,
  validateSchema(updateIncidentTypeSchema),
  incidentTypeController.update
);

router.delete(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  requireMainAdmin,
  incidentTypeController.delete
);

export default router;
