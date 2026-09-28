import { UnitRepository } from "@/repositories/unit.repository";
import { UpdateUnitInput } from "@/schema/unit/update-unit.schema";
import { prisma } from "@/lib/prisma";
import { WorkflowConflict, isWorkflowConflict } from "@/lib/workflow-error";

const unitRepository = new UnitRepository();

export const UpdateUnitService = async (id: string, data: UpdateUnitInput) => {
  try {
    const existing = await unitRepository.findById(id);

    if (!existing) {
      return { code: 404, status: "error", message: "Unit not found" };
    }

    // If unitName is being changed, check for conflicts with other records
    if (data.unitName && data.unitName !== existing.unitName) {
      const nameConflict = await unitRepository.findByName(data.unitName);
      if (nameConflict) {
        return {
          code: 409,
          status: "error",
          message: `A unit named "${data.unitName}" already exists`,
        };
      }
    }

    const unit = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT unit_id FROM units WHERE unit_id = ${id}::uuid FOR UPDATE`;
      if (data.status && data.status !== "DEPLOYED") {
        const active = await tx.incidentUnit.count({ where: { unitId: id, status: { not: "RETURNED" } } });
        if (active) throw new WorkflowConflict("Return all active dispatches before changing the unit's availability");
      }
      return tx.unit.update({ where: { unitId: id, status: existing.status }, data });
    });

    return {
      code: 200,
      status: "success",
      message: "Unit updated successfully",
      data: { unit },
    };
  } catch (error) {
    if (isWorkflowConflict(error)) return { code: 409, status: "error", message: error instanceof WorkflowConflict ? error.message : "Unit changed concurrently. Refresh and retry." };
    console.error("UpdateUnitService Error", error);
    return { code: 500, status: "error", message: "Failed to update unit" };
  }
};
