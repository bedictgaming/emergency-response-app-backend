import { Router } from "express";
import { LocationController } from "@/controllers/location.controller";
import { validateSchema } from "@/middlewares/validate.schema";
import { createLocationSchema, updateLocationSchema } from "@/schema/location";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { permittedRole, requireMainAdmin } from "@/middlewares/rbac-middleware";
import { Role } from "@/generated/prisma";

// Initialize
const router = Router();
const locationController = new LocationController();
const authMiddleware = new AuthMiddleware();

// Incident locations include reporter-supplied addresses and coordinates.
router.get("/v1/", authMiddleware.execute, permittedRole([Role.ADMIN]), requireMainAdmin, locationController.getAll);
router.get("/v1/:id", authMiddleware.execute, permittedRole([Role.ADMIN]), requireMainAdmin, locationController.getById);

// Protected Routes (ADMIN only)
router.post("/v1/", authMiddleware.execute, permittedRole([Role.ADMIN]), requireMainAdmin, validateSchema(createLocationSchema), locationController.create);
router.put("/v1/:id", authMiddleware.execute, permittedRole([Role.ADMIN]), requireMainAdmin, validateSchema(updateLocationSchema), locationController.update);
router.delete("/v1/:id", authMiddleware.execute, permittedRole([Role.ADMIN]), requireMainAdmin, locationController.delete);

export default router;
