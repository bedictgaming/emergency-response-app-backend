import { Router } from "express";
import { UserController } from "@/controllers/user.controller";
import { validateSchema } from "@/middleware/validate.schema";
import { updateUserRoleSchema, updateUserStatusSchema } from "@/validation/user";
import { AuthMiddleware } from "@/middleware/auth-middleware";
import { requireMainAdmin, requirePermission } from "@/middleware/rbac-middleware";
import { Permission } from "@/domain/permissions.policy";
import { z } from 'zod';

// Initialize
const router = Router();
const userController = new UserController();
const authMiddleware = new AuthMiddleware();

// All user administration endpoints are strictly ADMIN only
router.use(authMiddleware.execute, requirePermission(Permission.UserManage), requireMainAdmin);

// List all system users (with role and search filters)
router.get("/v1/", userController.getAll);

const accountSafetySchema = z.object({ params: z.object({ id: z.string().min(1).max(128) }),
  body: z.object({}).strict().optional(), query: z.object({}).strict() });
router.get('/v1/:id/violations', validateSchema(accountSafetySchema), userController.violations);
router.post('/v1/:id/password-reset', validateSchema(accountSafetySchema), userController.requestPasswordReset);

// View user detail profile
router.get("/v1/:id", userController.getById);

// Update user role (USER / ADMIN)
router.put(
  "/v1/:id/role",
  validateSchema(updateUserRoleSchema),
  userController.updateRole
);

router.patch("/v1/:id/status", validateSchema(updateUserStatusSchema), userController.updateStatus);

// Delete user account
router.delete("/v1/:id", userController.delete);

export default router;
