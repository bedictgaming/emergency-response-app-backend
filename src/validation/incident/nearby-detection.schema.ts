import { z } from 'zod';
import { ResponseService } from '@/generated/prisma';

export const nearbyDetectionBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('citizen'), latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    services: z.array(z.enum(ResponseService)).min(1).max(4) }).strict(),
  // Operational coordinates and services come from the authorized report, never the client.
  z.object({ kind: z.literal('department'), incidentId: z.uuid() }).strict(),
]);
export const nearbyDetectionSchema = z.object({ body: nearbyDetectionBody });
export type NearbyDetectionInput = z.infer<typeof nearbyDetectionBody>;
