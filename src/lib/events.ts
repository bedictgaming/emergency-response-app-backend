import { EventEmitter } from "node:events";

export type EmergencyEvent = {
  type: "incident.created" | "incident.updated" | "incident.verified" | "alert.created" | "dispatch.updated" | "task.updated";
  entityId: string;
  occurredAt: string;
};

const bus = new EventEmitter();
bus.setMaxListeners(250);

export function publishEmergencyEvent(event: Omit<EmergencyEvent, "occurredAt">) {
  bus.emit("event", { ...event, occurredAt: new Date().toISOString() } satisfies EmergencyEvent);
}

export function subscribeEmergencyEvents(listener: (event: EmergencyEvent) => void) {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
