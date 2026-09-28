import { Router } from "express";
import { BarangayController } from "@/controllers/barangay.controller";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { permittedRole, requireMainAdmin } from "@/middlewares/rbac-middleware";
import { Role } from "@/generated/prisma";
import { validateSchema } from "@/middlewares/validate.schema";
import { updateBarangaySchema } from "@/schema/barangay/update-barangay.schema";

const router = Router();
const barangayController = new BarangayController();
const authMiddleware = new AuthMiddleware();

// Public / Authenticated Routes
router.get("/v1/", barangayController.getAll);
router.get("/v1/:id", barangayController.getById);
router.get("/v1/:id/incidents", authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), barangayController.getIncidents);

// Admin Only Routes
router.put(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN]),
  requireMainAdmin,
  validateSchema(updateBarangaySchema),
  barangayController.update
);

export default router;
