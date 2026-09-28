import { Router } from "express";
import authRoutes from "@/routes/auth.routes";
import locationRoutes from "@/routes/location.routes";
import incidentRoutes from "@/routes/incident.routes";
import incidentTypeRoutes from "@/routes/incident-type.routes";
import unitRoutes from "@/routes/unit.routes";
import taskRoutes from "@/routes/task.routes";
import responderRoutes from "@/routes/responder.routes";
import resourceRoutes from "@/routes/resource.routes";
import incidentUnitRoutes from "@/routes/incident-unit.routes";
import alertRoutes from "@/routes/alert.routes";
import attachmentRoutes from "@/routes/attachment.routes";
import userRoutes from "@/routes/user.routes";
import barangayRoutes from "@/routes/barangay.routes";
import analyticsRoutes from "@/routes/analytics.routes";
import uploadRoutes from "@/routes/upload.routes";
import eventRoutes from "@/routes/event.routes";
import notificationRoutes from "@/routes/notification.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/locations", locationRoutes);
router.use("/barangays", barangayRoutes);
router.use("/analytics", analyticsRoutes);
router.use("/incidents", incidentRoutes);
router.use("/incident-types", incidentTypeRoutes);
router.use("/units", unitRoutes);
router.use("/tasks", taskRoutes);
router.use("/responders", responderRoutes);
router.use("/resources", resourceRoutes);
router.use("/incident-units", incidentUnitRoutes);
router.use("/alerts", alertRoutes);
router.use("/attachments", attachmentRoutes);
router.use("/users", userRoutes);
router.use("/upload", uploadRoutes);
router.use("/events", eventRoutes);
router.use("/notifications", notificationRoutes);

export default router;









