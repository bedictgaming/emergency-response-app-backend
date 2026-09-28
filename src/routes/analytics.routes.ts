import { Router } from "express";
import { AnalyticsController } from "@/controllers/analytics.controller";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { requirePermission } from "@/middlewares/rbac-middleware";
import { Permission } from "@/lib/permissions";

const router = Router();
const analyticsController = new AnalyticsController();
const authMiddleware = new AuthMiddleware();

// Protected routes (Admin & Dispatchers)
router.use(authMiddleware.execute, requirePermission(Permission.AnalyticsReadDepartment));
router.get("/v1/incidents-by-barangay", analyticsController.getIncidentsByBarangay);
router.get("/v1/incidents-by-type", analyticsController.getIncidentsByType);
router.get("/v1/resolved-summary", analyticsController.getResolvedSummary);
router.get("/v1/dashboard", analyticsController.getDashboard);

export default router;
