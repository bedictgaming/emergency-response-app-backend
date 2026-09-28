import { z } from "zod";
import { IncidentStatus, ResponseService, ServiceResponseStatus, SeverityLevel } from "@/generated/prisma";

const positivePage = z.coerce.number().int().positive().finite().optional();
const uuidFilter = z.string().uuid().optional();
const dateFilter = z.string().refine(value => !Number.isNaN(Date.parse(value)), "Invalid date").optional();
const csvEnums = <T extends string>(values: readonly T[]) => z.string().refine(value =>
  value.split(",").every(item => values.includes(item.trim() as T)), "Invalid status filter").optional();

export const listIncidentsSchema = z.object({
  query: z.object({
    page: positivePage,
    limit: positivePage,
    status: z.nativeEnum(IncidentStatus).optional(),
    statuses: csvEnums(Object.values(IncidentStatus)),
    responseService: z.nativeEnum(ResponseService).optional(),
    serviceStatuses: csvEnums(Object.values(ServiceResponseStatus)),
    severityLevel: z.nativeEnum(SeverityLevel).optional(),
    typeId: uuidFilter,
    locationId: uuidFilter,
    barangayId: uuidFilter,
    reportedBy: uuidFilter,
    from: dateFilter,
    to: dateFilter,
  }),
});
