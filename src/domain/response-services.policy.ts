import { ResponseService } from "@/generated/prisma";

const SERVICE_TERMS: Record<ResponseService, string[]> = {
  FIRE: ["fire", "bfp"],
  MEDICAL: ["medical", "med", "ambulance", "ems", "health"],
  POLICE: ["police", "pnp", "security", "crime"],
  HAZARD: ["hazard", "flood", "weather", "storm", "disaster", "drrmo", "rescue"],
};

export function responseServiceTerms(service: ResponseService): string[] {
  return [...SERVICE_TERMS[service]];
}

export function responseServiceFromText(value?: string | null): ResponseService | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return (Object.entries(SERVICE_TERMS) as [ResponseService, string[]][])
    .find(([, terms]) => terms.some((term) => normalized.includes(term)))?.[0];
}

export function normalizeResponseServices(values?: ResponseService[]): ResponseService[] {
  return [...new Set(values ?? [])].sort();
}

export function responseServicesForIncident(incident: {
  requestedServices?: ResponseService[];
  type?: { typeName?: string | null } | null;
}): ResponseService[] {
  const requested = normalizeResponseServices(incident.requestedServices);
  if (requested.length > 0) return requested;
  const primary = responseServiceFromText(incident.type?.typeName);
  return primary ? [primary] : [];
}

export function sameResponseServices(first: ResponseService[], second: ResponseService[]): boolean {
  const normalizedFirst = normalizeResponseServices(first);
  const normalizedSecond = normalizeResponseServices(second);
  return normalizedFirst.length === normalizedSecond.length
    && normalizedFirst.every((service, index) => service === normalizedSecond[index]);
}

export function overlappingResponseServices(first: ResponseService[], second: ResponseService[]): boolean {
  const secondSet = new Set(normalizeResponseServices(second));
  return normalizeResponseServices(first).some((service) => secondSet.has(service));
}

export function unitTypeSupportsService(unitType: string, services: ResponseService[]): boolean {
  const normalized = unitType.toLowerCase();
  return services.some((service) => SERVICE_TERMS[service].some((term) => normalized.includes(term)));
}
