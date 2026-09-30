import { Router } from "express";
import rateLimit from "express-rate-limit";
import { IncidentController } from "@/controllers/incident.controller";
import { TaskController } from "@/controllers/task.controller";
import { IncidentUnitController } from "@/controllers/incident-unit.controller";
import { AttachmentController } from "@/controllers/attachment.controller";
import { validateSchema } from "@/middlewares/validate.schema";
import { checkNearbyIncidentSchema, createIncidentSchema, mergeIncidentSchema, updateIncidentSchema, updateServiceResponseSchema, verifyIncidentSchema } from "@/schema/incident";
import { createTaskSchema } from "@/schema/task";
import { dispatchUnitSchema } from "@/schema/incident-unit";
import { createAttachmentSchema } from "@/schema/attachment";
import { listIncidentsSchema } from "@/schema/incident/list-incidents.schema";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { permittedRole, requireAnyPermission, requireMainAdmin, requirePermission } from "@/middlewares/rbac-middleware";
import { Role } from "@/generated/prisma";
import { Permission } from "@/lib/permissions";
import { requireIncidentAccess } from "@/middlewares/incident-access-middleware";
import { requireTargetResponderDepartment, requireTargetUnitDepartment, requireUnitDepartment } from "@/middlewares/operational-access-middleware";
import { deleteIncidentSchema, flagIncidentSchema, listReviewFlagsSchema, reviewIncidentFlagSchema } from "@/schema/incident/review-incident.schema";

// Initialize
const router = Router();
const incidentController = new IncidentController();
const taskController = new TaskController();
const incidentUnitController = new IncidentUnitController();
const attachmentController = new AttachmentController();
const authMiddleware = new AuthMiddleware();
const nearbyCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => (req as typeof req & { user: { sub: string } }).user.sub,
  message: { code: 429, status: "error", message: "Too many nearby checks. Wait before trying again." },
});

// Public Routes (still authenticated — anyone logged in can view incidents)
router.get("/v1/", authMiddleware.execute, validateSchema(listIncidentsSchema), incidentController.getAll);
router.get("/v1/review-flags", authMiddleware.execute, requireMainAdmin, validateSchema(listReviewFlagsSchema), incidentController.listReviewFlags);
router.get("/v1/:id", authMiddleware.execute, requireIncidentAccess, incidentController.getById);

router.post("/v1/:id/review-flags", authMiddleware.execute, permittedRole([Role.ADMIN]), requirePermission(Permission.IncidentManageDepartment), validateSchema(flagIncidentSchema), requireIncidentAccess, incidentController.flag);
router.patch("/v1/:id/review-flags/:flagId", authMiddleware.execute, requireMainAdmin, validateSchema(reviewIncidentFlagSchema), requireIncidentAccess, incidentController.reviewFlag);

// Protected Routes — any authenticated user can report an incident
router.post(
  "/v1/nearby-check",
  authMiddleware.execute,
  requirePermission(Permission.IncidentCreateOwn),
  nearbyCheckLimiter,
  validateSchema(checkNearbyIncidentSchema),
  incidentController.checkNearby,
);

router.post(
  "/v1/",
  authMiddleware.execute,
  requireAnyPermission(Permission.IncidentCreateOwn, Permission.IncidentManageDepartment),
  validateSchema(createIncidentSchema),
  incidentController.create
);

// Protected Routes — only ADMIN can update incident status
router.put(
  "/v1/:id",
  authMiddleware.execute,
  requirePermission(Permission.IncidentManageDepartment),
  requireIncidentAccess,
  validateSchema(updateIncidentSchema),
  incidentController.update
);

router.patch(
  "/v1/:id/services/:service",
  authMiddleware.execute,
  requirePermission(Permission.IncidentManageDepartment),
  requireIncidentAccess,
  validateSchema(updateServiceResponseSchema),
  incidentController.updateServiceResponse,
);

router.post(
  "/v1/:id/merge",
  authMiddleware.execute,
  requirePermission(Permission.IncidentManageAll),
  requireIncidentAccess,
  requireMainAdmin,
  validateSchema(mergeIncidentSchema),
  incidentController.merge,
);

// Only the main administrator can permanently delete a closed report.
router.delete(
  "/v1/:id",
  authMiddleware.execute,
  requirePermission(Permission.IncidentManageAll),
  validateSchema(deleteIncidentSchema),
  requireIncidentAccess,
  requireMainAdmin,
  incidentController.delete
);

router.patch(
  "/v1/:id/verify",
  authMiddleware.execute,
  requirePermission(Permission.IncidentManageDepartment),
  requireIncidentAccess,
  validateSchema(verifyIncidentSchema),
  incidentController.verify,
);

// Nested Unit Dispatching Routes — POST /incidents/v1/:incidentId/units
router.post(
  "/v1/:incidentId/units",
  authMiddleware.execute,
  requirePermission(Permission.DispatchManageDepartment),
  requireIncidentAccess,
  validateSchema(dispatchUnitSchema),
  requireTargetUnitDepartment,
  incidentUnitController.dispatch
);

// Nested Unit Dispatching Routes — GET /incidents/v1/:incidentId/units
router.get(
  "/v1/:incidentId/units",
  authMiddleware.execute,
  permittedRole([Role.ADMIN, Role.DISPATCHER, Role.RESPONDER]),
  requireIncidentAccess,
  incidentUnitController.getAll
);

// Nested Unit Dispatching Routes — DELETE /incidents/v1/:incidentId/units/:unitId
router.delete(
  "/v1/:incidentId/units/:unitId",
  authMiddleware.execute,
  requirePermission(Permission.DispatchManageDepartment),
  requireIncidentAccess,
  requireUnitDepartment,
  incidentUnitController.removeByPair
);

// Nested Task Routes — POST /incidents/v1/:incidentId/tasks
router.post(
  "/v1/:incidentId/tasks",
  authMiddleware.execute,
  requirePermission(Permission.TaskManageDepartment),
  requireIncidentAccess,
  validateSchema(createTaskSchema),
  requireTargetResponderDepartment,
  taskController.create
);

// Nested Task Routes — GET /incidents/v1/:incidentId/tasks
router.get(
  "/v1/:incidentId/tasks",
  authMiddleware.execute,
  permittedRole([Role.ADMIN, Role.DISPATCHER, Role.RESPONDER]),
  requireIncidentAccess,
  taskController.getAll
);

// Nested Attachment Routes — POST /incidents/v1/:incidentId/attachments
router.post(
  "/v1/:incidentId/attachments",
  authMiddleware.execute,
  requireIncidentAccess,
  validateSchema(createAttachmentSchema),
  attachmentController.create
);

// Nested Attachment Routes — GET /incidents/v1/:incidentId/attachments
router.get(
  "/v1/:incidentId/attachments",
  authMiddleware.execute,
  requireIncidentAccess,
  attachmentController.getByIncident
);

export default router;
