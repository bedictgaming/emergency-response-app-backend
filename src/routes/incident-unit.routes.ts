import { Router } from "express";
import { IncidentUnitController } from "@/controllers/incident-unit.controller";
import { validateSchema } from "@/middlewares/validate.schema";
import { updateIncidentUnitSchema } from "@/schema/incident-unit";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { permittedRole } from "@/middlewares/rbac-middleware";
import { Role } from "@/generated/prisma";
import { requireIncidentUnitDepartment } from "@/middlewares/operational-access-middleware";

// Initialize
const router = Router();
const incidentUnitController = new IncidentUnitController();
const authMiddleware = new AuthMiddleware();

router.use(authMiddleware.execute);

// Authenticated Routes
router.get("/v1/", permittedRole([Role.ADMIN, Role.DISPATCHER, Role.RESPONDER]), incidentUnitController.getAll);
router.get("/v1/:id", permittedRole([Role.ADMIN, Role.DISPATCHER, Role.RESPONDER]), requireIncidentUnitDepartment, incidentUnitController.getById);

// Update dispatch status/role
router.put(
  "/v1/:id",
  permittedRole([Role.ADMIN, Role.DISPATCHER, Role.RESPONDER]),
  requireIncidentUnitDepartment,
  validateSchema(updateIncidentUnitSchema),
  incidentUnitController.update
);

// Delete/unassign dispatch record
router.delete("/v1/:id", permittedRole([Role.ADMIN, Role.DISPATCHER]), requireIncidentUnitDepartment, incidentUnitController.remove);

export default router;
