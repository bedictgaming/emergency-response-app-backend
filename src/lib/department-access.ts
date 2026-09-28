import { Department, Prisma, ResponseService } from "@/generated/prisma";
import type { JwtPayload } from "@/lib/jwt";
import { responseServiceTerms } from "@/lib/response-services";
import { isMainAdministrator } from "@/lib/permissions";

type OperationalActor = Pick<JwtPayload, "role" | "department" | "isMainAdmin">;

export const departmentService = (department?: Department | null): ResponseService | undefined => {
  if (!department || department === Department.MAIN) return undefined;
  return department === Department.DRRMO ? ResponseService.HAZARD : department as unknown as ResponseService;
};

export function departmentIncidentScope(actor: OperationalActor): Prisma.IncidentWhereInput {
  if (isMainAdministrator(actor)) return {};
  // Missing, MAIN-without-main-admin, or otherwise invalid assignments fail closed.
  const service = departmentService(actor.department);
  if (!service) return { incidentId: "00000000-0000-0000-0000-000000000000" };
  const terms: Record<ResponseService, string[]> = {
    FIRE: ["fire", "bfp"], MEDICAL: ["medical", "med", "ambulance", "ems", "health"],
    POLICE: ["police", "pnp", "security", "crime"], HAZARD: ["hazard", "flood", "weather", "storm", "disaster", "drrmo", "rescue"],
  };
  return { OR: [
    { requestedServices: { has: service } },
    { requestedServices: { isEmpty: true }, type: { typeName: { contains: terms[service][0], mode: "insensitive" } } },
  ] };
}

export function actorCanManageUsers(actor: OperationalActor) {
  return isMainAdministrator(actor);
}

export function departmentUnitScope(actor: OperationalActor): Prisma.UnitWhereInput {
  if (isMainAdministrator(actor)) return {};
  const service = departmentService(actor.department);
  if (!service) return { unitId: "00000000-0000-0000-0000-000000000000" };
  return { OR: responseServiceTerms(service).map((term) => ({ unitType: { contains: term, mode: "insensitive" } })) };
}

export function departmentDispatchScope(actor: OperationalActor): Prisma.IncidentUnitWhereInput {
  if (isMainAdministrator(actor)) return {};
  return { incident: departmentIncidentScope(actor), unit: departmentUnitScope(actor) };
}

export function departmentTaskScope(actor: OperationalActor): Prisma.TaskWhereInput {
  if (isMainAdministrator(actor)) return {};
  const service = departmentService(actor.department);
  if (!service) return { taskId: "00000000-0000-0000-0000-000000000000" };
  return {
    incident: departmentIncidentScope(actor),
    OR: [
      { assignee: { unit: departmentUnitScope(actor) } },
      // An unassigned task on a shared incident has no department owner.
      // Only the main administrator may manage it until it is assigned.
      { assignedTo: null, incident: { requestedServices: { equals: [service] } } },
      { assignedTo: null, incident: { requestedServices: { isEmpty: true }, ...departmentIncidentScope(actor) } },
    ],
  };
}
