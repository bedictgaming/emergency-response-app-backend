import { Router } from "express";
import rateLimit from "express-rate-limit";
import { IncidentController } from "@/controllers/incident.controller";
import { TaskController } from "@/controllers/task.controller";
import { AttachmentController } from "@/controllers/attachment.controller";
import { validateSchema } from "@/middleware/validate.schema";
import { checkNearbyIncidentSchema, createIncidentSchema, mergeIncidentSchema, updateIncidentSchema, updateServiceResponseSchema, verifyIncidentSchema } from "@/validation/incident";
import { createTaskSchema } from "@/validation/task";
import { createAttachmentSchema } from "@/validation/attachment";
import { listIncidentsSchema } from "@/validation/incident/list-incidents.schema";
import { AuthMiddleware } from "@/middleware/auth-middleware";
import { permittedRole, requireAnyPermission, requireMainAdmin, requirePermission } from "@/middleware/rbac-middleware";
import { Role } from "@/generated/prisma";
import { Permission } from "@/domain/permissions.policy";
import { requireIncidentAccess } from "@/middleware/incident-access-middleware";
import { requireTargetResponderDepartment } from "@/middleware/operational-access-middleware";
import { retiredUnitWorkflow } from '@/middleware/retired-unit-workflow';
import { cancelFalseIncidentSchema, correctIncidentFlagSchema, deleteIncidentSchema, flagIncidentSchema, listReviewFlagsSchema, reviewIncidentFlagSchema } from "@/validation/incident/review-incident.schema";
import { z } from 'zod';
import { ResponseService } from '@/generated/prisma';
import type { JwtPayload } from '@/lib/jwt';
import { acknowledgeIncidentAttention, listIncidentAttention } from '@/services/incident/incident-attention-service';
import { nearbyDetectionSchema } from '@/validation/incident/nearby-detection.schema';
import { NearbyDetectionService } from '@/services/incident/nearby-detection-service';
import { DecideNearbyReview, ListNearbyReviews, StartNearbyResponse } from '@/services/incident/nearby-review-service';
import { FlagNearbyReview } from '@/services/incident/review-incident-service';
import { departmentReportReviewEnabled } from '@/config/report-review';

// Initialize
const router = Router();
const incidentController = new IncidentController();
const taskController = new TaskController();
const attachmentController = new AttachmentController();
const authMiddleware = new AuthMiddleware();
const reviewAuthority: typeof requireMainAdmin = (req, res, next) => departmentReportReviewEnabled()
  ? permittedRole([Role.ADMIN])(req, res, next) : requireMainAdmin(req, res, next);
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
router.get('/v1/nearby-reviews', authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), async (req, res) => {
  const query = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), incidentId: z.uuid().optional(),
    status: z.enum(['PENDING', 'ACKNOWLEDGED', 'REJECTED']).optional() }).strict().safeParse(req.query);
  if (!query.success) return res.status(400).json({ message: 'Invalid nearby review query' });
  try { const result = await ListNearbyReviews(req.user as JwtPayload, query.data); return res.status(result.code).json(result); }
  catch { return res.status(503).json({ message: 'Nearby review queue unavailable. Retry; reports remain unchanged.' }); }
});
router.post('/v1/nearby-reviews/:reviewId/decision', authMiddleware.execute, permittedRole([Role.ADMIN]), async (req, res) => {
  const body = z.object({ status: z.enum(['ACKNOWLEDGED', 'REJECTED']), version: z.number().int().positive().max(2147483646),
    reason: z.string().trim().max(500).optional() }).strict().safeParse(req.body);
  if (!body.success || !z.uuid().safeParse(req.params.reviewId).success) return res.status(400).json({ message: 'Invalid nearby review decision' });
  const result = await DecideNearbyReview(String(req.params.reviewId), body.data, req.user as JwtPayload);
  return res.status(result.code).json(result);
});
router.post('/v1/nearby-reviews/:reviewId/flag', authMiddleware.execute, permittedRole([Role.ADMIN]), async (req, res) => {
  const body = z.object({ version: z.number().int().positive().max(2147483646), reason: z.string().trim().min(10).max(500) }).strict().safeParse(req.body);
  if (!body.success || !z.uuid().safeParse(req.params.reviewId).success) return res.status(400).json({ message: 'Invalid nearby review flag' });
  const result = await FlagNearbyReview(String(req.params.reviewId), body.data.version, body.data.reason, req.user as JwtPayload);
  return res.status(result.code).json(result);
});
router.post('/v1/nearby-reviews/:reviewId/start-response', authMiddleware.execute, permittedRole([Role.ADMIN]), async (req, res) => {
  const body = z.object({ version: z.number().int().positive().max(2147483646) }).strict().safeParse(req.body);
  if (!body.success || !z.uuid().safeParse(req.params.reviewId).success) return res.status(400).json({ message: 'Invalid nearby response start' });
  const result = await StartNearbyResponse(String(req.params.reviewId), body.data.version, req.user as JwtPayload);
  return res.status(result.code).json(result);
});
router.get("/v1/review-flags", authMiddleware.execute, reviewAuthority, validateSchema(listReviewFlagsSchema), incidentController.listReviewFlags);
const attentionQuery = z.object({ responseService: z.enum(ResponseService).optional() }).strict();
router.get('/v1/attention', authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), async (req, res) => {
  const query = attentionQuery.safeParse(req.query);
  if (!query.success) return res.status(400).json({ message: 'Invalid attention query' });
  try {
    const data = await listIncidentAttention(req.user as JwtPayload, query.data.responseService);
    if (!data) return res.status(403).json({ message: 'Operational department required' });
    return res.json({ data });
  } catch { return res.status(503).json({ message: 'Alert queue unavailable. Retry; reports remain unchanged.' }); }
});
router.post('/v1/:id/attention/acknowledge', authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), async (req, res) => {
  const body = z.object({ version: z.number().int().positive().max(2147483647), responseService: z.enum(ResponseService).optional() }).strict().safeParse(req.body);
  if (!z.uuid().safeParse(req.params.id).success || !body.success) return res.status(400).json({ message: 'Invalid acknowledgement' });
  try {
    const code = await acknowledgeIncidentAttention(req.user as JwtPayload, String(req.params.id), body.data.version, body.data.responseService);
    return res.status(code).json({ message: code === 200 ? 'Alert acknowledgement saved; response status unchanged' : code === 409 ? 'Alert changed; refresh the queue' : 'Alert unavailable' });
  } catch { return res.status(503).json({ message: 'Acknowledgement not confirmed. Retry safely.' }); }
});
router.get("/v1/:id", authMiddleware.execute, requireIncidentAccess, incidentController.getById);

router.post("/v1/:id/review-flags", authMiddleware.execute, permittedRole([Role.ADMIN]), requirePermission(Permission.IncidentManageDepartment), validateSchema(flagIncidentSchema), requireIncidentAccess, incidentController.flag);
router.patch("/v1/:id/review-flags/:flagId", authMiddleware.execute, reviewAuthority, validateSchema(reviewIncidentFlagSchema), requireIncidentAccess, incidentController.reviewFlag);
router.post("/v1/:id/review-flags/:flagId/correction", authMiddleware.execute, reviewAuthority, validateSchema(correctIncidentFlagSchema), requireIncidentAccess, incidentController.correctReviewFlag);
router.post('/v1/:id/cancel-confirmed-false', authMiddleware.execute, reviewAuthority, validateSchema(cancelFalseIncidentSchema), requireIncidentAccess, incidentController.cancelFalse);

// Protected Routes — any authenticated user can report an incident
const detectionLimiter = rateLimit({ windowMs: 60_000, limit: 150,
  keyGenerator: req => (req.user as JwtPayload).sub, standardHeaders: 'draft-8', legacyHeaders: false });
router.post('/v1/nearby-detection', authMiddleware.execute, permittedRole([Role.USER, Role.ADMIN, Role.DISPATCHER]),
  detectionLimiter, validateSchema(nearbyDetectionSchema), async (req, res) => {
    const result = await NearbyDetectionService(req.body, req.user as JwtPayload);
    return res.status(result.code).json(result);
  });

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

// Retired aliases retain auth and report scope; historical detail DTOs remain.
for (const path of ['/v1/:incidentId/units', '/v1/:incidentId/units/:unitId']) {
  router.all(path, authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), requireIncidentAccess, retiredUnitWorkflow);
}

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
  permittedRole([Role.ADMIN, Role.DISPATCHER]),
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
