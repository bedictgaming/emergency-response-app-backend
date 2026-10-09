import { Router } from "express";
import { TaskController } from "@/controllers/task.controller";
import { validateSchema } from "@/middlewares/validate.schema";
import { updateTaskSchema } from "@/schema/task";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { permittedRole } from "@/middlewares/rbac-middleware";
import { Role } from "@/generated/prisma";
import { requireTargetResponderDepartment, requireTaskDepartment } from "@/middlewares/operational-access-middleware";

// Initialize
const router = Router();
const taskController = new TaskController();
const authMiddleware = new AuthMiddleware();

// GET /tasks/v1/ — all authenticated users can list/filter tasks
router.get("/v1/", authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), taskController.getAll);

// GET /tasks/v1/:id — all authenticated users can view task detail
router.get("/v1/:id", authMiddleware.execute, permittedRole([Role.ADMIN, Role.DISPATCHER]), requireTaskDepartment, taskController.getById);

// PUT /tasks/v1/:id — all authenticated users (RBAC enforced in service)
router.put(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN, Role.DISPATCHER]),
  requireTaskDepartment,
  validateSchema(updateTaskSchema),
  requireTargetResponderDepartment,
  taskController.update
);

// DELETE /tasks/v1/:id — ADMIN only
router.delete(
  "/v1/:id",
  authMiddleware.execute,
  permittedRole([Role.ADMIN, Role.DISPATCHER]),
  requireTaskDepartment,
  taskController.delete
);

export default router;
