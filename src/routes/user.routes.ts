import { Router } from "express";
import { UserController } from "@/controllers/user.controller";
import { validateSchema } from "@/middlewares/validate.schema";
import { updateUserRoleSchema, updateUserStatusSchema } from "@/schema/user";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { requireMainAdmin, requirePermission } from "@/middlewares/rbac-middleware";
import { Permission } from "@/lib/permissions";

// Initialize
const router = Router();
const userController = new UserController();
const authMiddleware = new AuthMiddleware();

// All user administration endpoints are strictly ADMIN only
router.use(authMiddleware.execute, requirePermission(Permission.UserManage), requireMainAdmin);

// List all system users (with role and search filters)
router.get("/v1/", userController.getAll);

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
