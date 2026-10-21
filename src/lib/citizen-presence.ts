import { distanceBetweenCoordinatesMeters } from '@/domain/incident-proximity.policy';

export const PRESENCE_TTL_MS = 30_000;
export const PRESENCE_FIX_MAX_AGE_MS = 60_000;
export type PresenceActor = { sub: string; sessionId?: string };
export type PresenceFix = { latitude: number; longitude: number; accuracy: number; timestamp: number };
type Entry = PresenceFix & { actor: string; user: string; visit: string; expiresAt: number };
export const PRESENCE_SHARING = 'exact-gps-v1' as const;
export type PresencePosition = Pick<PresenceFix, 'latitude' | 'longitude' | 'accuracy'>;
const keyFor = (actor: PresenceActor) => `${actor.sub}:${actor.sessionId}`;
const distance = (a: PresenceFix, b: PresenceFix) => distanceBetweenCoordinatesMeters(a.latitude, a.longitude, b.latitude, b.longitude);

/** Volatile current presence only. Never serialize this store into a database,
 * audit, event payload, log, backup or a browser-visible peer record. */
export class CitizenPresenceStore {
  private entries = new Map<string, Entry>();
  private sockets = new Map<string, number>();
  private listeners = new Map<string, Set<() => void>>();
  // Coordinate-free short tombstones stop an in-flight heartbeat resurrecting
  // a visit after pagehide/leave. Capacity fails closed rather than evicting one.
  private ended = new Map<string, number>();
  constructor(private now = Date.now) {}
  private notify(changes: Entry[]) {
    if (!changes.length) return;
    const actors = new Set<string>();
    for (const viewer of this.entries.values()) {
      if (viewer.expiresAt <= this.now()) continue;
      if (changes.some(change => change.user !== viewer.user && distance(viewer, change) <= 100)) actors.add(viewer.actor);
    }
    for (const actor of actors) this.listeners.get(actor)?.forEach(listener => listener());
  }
  connect(actor: PresenceActor) {
    const key = keyFor(actor);
    this.sockets.set(key, (this.sockets.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const count = (this.sockets.get(key) ?? 1) - 1;
      if (count > 0) { this.sockets.set(key, count); return; }
      this.sockets.delete(key);
      const removed = [...this.entries.values()].filter(entry => entry.actor === key);
      for (const [id, entry] of this.entries) if (entry.actor === key) this.entries.delete(id);
      this.notify(removed);
    };
  }
  subscribe(actor: PresenceActor, listener: () => void) {
    const key = keyFor(actor), listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener); this.listeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
  sweep() {
    for (const [id, until] of this.ended) if (until <= this.now()) this.ended.delete(id);
    const expired: Entry[] = [];
    for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) { expired.push(entry); this.entries.delete(id); }
    this.notify(expired);
  }
  update(actor: PresenceActor, visit: string, fix: PresenceFix) {
    this.sweep();
    const key = keyFor(actor), id = `${key}:${visit}`, previous = this.entries.get(id);
    if (!this.sockets.has(key)) return 409;
    if (this.ended.has(id) || (previous && fix.timestamp < previous.timestamp)) return 409;
    if (!previous && this.ended.size >= 10_000) return 429;
    if (!previous && (this.entries.size >= 100 || [...this.entries.values()].filter(entry => entry.user === actor.sub).length >= 3)) return 429;
    const next: Entry = { ...fix, actor: key, user: actor.sub, visit, expiresAt: this.now() + PRESENCE_TTL_MS };
    this.entries.set(id, next);
    // Stationary heartbeat renewals need no peer fan-out. TTL expiry still does.
    if (!previous || previous.latitude !== next.latitude || previous.longitude !== next.longitude) this.notify(previous ? [previous, next] : [next]);
    return 200;
  }
  leave(actor: PresenceActor, visit: string) {
    const id = `${keyFor(actor)}:${visit}`, previous = this.entries.get(id);
    this.sweep();
    if (!this.ended.has(id) && this.ended.size < 10_000) this.ended.set(id, this.now() + PRESENCE_FIX_MAX_AGE_MS);
    this.entries.delete(id); if (previous) this.notify([previous]);
  }
  snapshot(actor: PresenceActor, visit: string) {
    this.sweep();
    const key = keyFor(actor), own = this.entries.get(`${key}:${visit}`);
    if (!own || !this.sockets.has(key)) return null;
    const peers = new Map<string, Entry>();
    for (const entry of this.entries.values()) {
      if (entry.user === own.user || !this.sockets.has(entry.actor)) continue;
      const previous = peers.get(entry.user);
      if (!previous || entry.timestamp > previous.timestamp) peers.set(entry.user, entry);
    }
    const positions: PresencePosition[] = [];
    for (const peer of peers.values()) {
      const meters = distance(own, peer);
      if (!Number.isFinite(meters) || meters > 100) continue;
      positions.push({ latitude: peer.latitude, longitude: peer.longitude, accuracy: peer.accuracy });
    }
    // Only v2 explicit exact-GPS participants can reach this snapshot. Never
    // include account/visit/session IDs, names, reports or a location history.
    return { precision: PRESENCE_SHARING, radiusMeters: 100 as const, expiresInSeconds: 30 as const, positions };
  }
}

export const citizenPresence = new CitizenPresenceStore();
