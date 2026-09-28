import { describe, expect, it } from "vitest";
import { departmentDispatchScope, departmentIncidentScope, departmentService, departmentTaskScope, departmentUnitScope } from "@/lib/department-access";

describe("department access scopes", () => {
  it("fails closed when an operational account has no explicit department", () => {
    expect(departmentIncidentScope({ role: "DISPATCHER", department: null, isMainAdmin: false })).toEqual({
      incidentId: "00000000-0000-0000-0000-000000000000",
    });
    expect(departmentUnitScope({ role: "DISPATCHER", department: null, isMainAdmin: false })).toEqual({
      unitId: "00000000-0000-0000-0000-000000000000",
    });
  });

  it("maps DRRMO accounts to the hazard response service", () => {
    expect(departmentService("DRRMO")).toBe("HAZARD");
    expect(departmentService("MEDICAL")).toBe("MEDICAL");
  });

  it("does not include hazard-only reports in the medical department scope", () => {
    const medicalScope = departmentIncidentScope({ role: "ADMIN", department: "MEDICAL", isMainAdmin: false });
    expect(medicalScope).toEqual({ OR: [
      { requestedServices: { has: "MEDICAL" } },
      { requestedServices: { isEmpty: true }, type: { typeName: { contains: "medical", mode: "insensitive" } } },
    ] });
    expect(medicalScope).not.toEqual(departmentIncidentScope({ role: "ADMIN", department: "DRRMO", isMainAdmin: false }));
  });

  it("allows a main administrator to query all incidents and units", () => {
    const actor = { role: "ADMIN", department: "MAIN" as const, isMainAdmin: true };
    expect(departmentIncidentScope(actor)).toEqual({});
    expect(departmentUnitScope(actor)).toEqual({});
    expect(departmentTaskScope(actor)).toEqual({});
    expect(departmentDispatchScope(actor)).toEqual({});
  });

  it("does not treat a MAIN dispatcher or a misplaced main-admin flag as global access", () => {
    for (const actor of [
      { role: "DISPATCHER", department: "MAIN" as const, isMainAdmin: true },
      { role: "ADMIN", department: "FIRE" as const, isMainAdmin: true },
    ]) {
      expect(departmentIncidentScope(actor)).not.toEqual({});
      expect(departmentUnitScope(actor)).not.toEqual({});
    }
  });

  it("requires ownership of a task or unit even when the incident serves two departments", () => {
    const actor = { role: "DISPATCHER", department: "MEDICAL" as const, isMainAdmin: false };
    const dispatchScope = departmentDispatchScope(actor);
    expect(dispatchScope).toEqual({
      incident: departmentIncidentScope(actor),
      unit: departmentUnitScope(actor),
    });
    const taskScope = departmentTaskScope(actor);
    expect(taskScope.incident).toEqual(departmentIncidentScope(actor));
    expect(taskScope.OR).toContainEqual({ assignee: { unit: departmentUnitScope(actor) } });
    expect(taskScope.OR).toContainEqual({ assignedTo: null, incident: { requestedServices: { equals: ["MEDICAL"] } } });
    expect(taskScope.OR).not.toContainEqual({ assignedTo: null, incident: departmentIncidentScope(actor) });
  });
});
