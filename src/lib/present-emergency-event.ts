import type { EmergencyEvent } from '@/lib/events';
import type { JwtPayload } from '@/lib/jwt';
import { canReceiveEvent } from '@/lib/event-access';

/** A generic dirty hint is not evidence that a report exists near this citizen. */
export async function presentEmergencyEvent(actor: JwtPayload, event: EmergencyEvent) {
  if (await canReceiveEvent(actor, event)) return { type: event.type, entityId: event.entityId, occurredAt: event.occurredAt };
  // Never broaden citizen ownership of normal events or expose a peer report ID.
  if (actor.role === 'USER' && event.type.startsWith('incident.')) return { type: 'nearby.changed' as const };
  return null;
}
