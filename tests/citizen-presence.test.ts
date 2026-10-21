import { describe, expect, it } from 'vitest';
import { CitizenPresenceStore, PRESENCE_TTL_MS } from '@/lib/citizen-presence';
import { validateCitizenPresenceConfiguration } from '@/config/citizen-presence';

const a = { sub: 'self', sessionId: 'a' }, b = { sub: 'peer', sessionId: 'b' };
const fix = (meters = 0, timestamp = 1000) => ({ latitude: 10.251 + meters / 111_320, longitude: 123.949, accuracy: 15, timestamp });
describe('volatile online citizen presence', () => {
  it('does not admit an HTTP heartbeat without the current authenticated WebSocket', () => {
    const store = new CitizenPresenceStore();
    expect(store.update(a, 'visit', fix())).toBe(409); expect(store.snapshot(a, 'visit')).toBeNull();
  });
  it('only includes fresh opted-in peers within the exact 100m GPS radius', () => {
    const store = new CitizenPresenceStore();
    store.connect(a); store.connect(b); store.connect({ sub: 'unshared', sessionId: 'c' });
    store.update(a, 'a', fix()); expect(store.snapshot(a, 'a')?.positions).toEqual([]);
    store.update(b, 'b', fix(99)); expect(store.snapshot(a, 'a')?.positions).toEqual([expect.objectContaining({ latitude: fix(99).latitude, longitude: fix(99).longitude })]);
    store.update(b, 'b', fix(101)); expect(store.snapshot(a, 'a')?.positions).toEqual([]);
  });
  it('excludes own tabs and returns opted-in GPS unchanged without identifiers or report data', () => {
    const store = new CitizenPresenceStore(), c = { sub: 'another', sessionId: 'c' };
    for (const actor of [a, b, c]) store.connect(actor);
    store.update(a, 'a', fix()); store.update(a, 'another-own-tab', fix(10));
    expect(store.snapshot(a, 'a')?.positions).toEqual([]);
    store.update(b, 'b', fix(10)); store.update(c, 'c', fix(20));
    const snapshot = store.snapshot(a, 'a');
    expect(snapshot).toEqual({ precision: 'exact-gps-v1', radiusMeters: 100, expiresInSeconds: 30, positions: [
      { latitude: fix(10).latitude, longitude: fix(10).longitude, accuracy: 15 },
      { latitude: fix(20).latitude, longitude: fix(20).longitude, accuracy: 15 },
    ] });
    for (const field of ['user', 'peer', 'visit', 'timestamp', 'count', 'incident', 'session']) expect(JSON.stringify(snapshot)).not.toContain(field);
    expect(store.snapshot({ ...a, sessionId: 'different' }, 'a')).toBeNull();
  });
  it('notifies only nearby participating accounts and does not fan out stationary heartbeats', () => {
    const store = new CitizenPresenceStore(), far = { sub: 'far', sessionId: 'far' };
    for (const actor of [a, b, far]) store.connect(actor);
    store.update(a, 'a', fix()); store.update(far, 'far', fix(500));
    let nearHints = 0, farHints = 0;
    store.subscribe(a, () => nearHints++); store.subscribe(far, () => farHints++);
    store.update(b, 'b', fix(20)); expect(nearHints).toBe(1); expect(farHints).toBe(0);
    store.update(b, 'b', fix(20, 1001)); expect(nearHints).toBe(1);
    store.update(b, 'b', fix(150, 1002)); expect(nearHints).toBe(2); expect(farHints).toBe(0);
  });
  it('expires silent visits without a saved history and invalidates nearby dots', () => {
    let now = 1000; const store = new CitizenPresenceStore(() => now);
    store.connect(a); store.connect(b); store.update(a, 'a', fix()); store.update(b, 'b', fix(20));
    let hints = 0; store.subscribe(a, () => hints++);
    now += PRESENCE_TTL_MS - 1; store.update(a, 'a', fix(0, now));
    now++; store.sweep(); expect(store.snapshot(a, 'a')?.positions).toEqual([]); expect(hints).toBe(1);
    expect(store.snapshot(b, 'b')).toBeNull();
  });
  it('removes the last disconnected session immediately but preserves another open socket', () => {
    const store = new CitizenPresenceStore(); store.connect(a);
    const close1 = store.connect(b), close2 = store.connect(b);
    store.update(a, 'a', fix()); store.update(b, 'b', fix(20));
    close1(); expect(store.snapshot(a, 'a')?.positions).toHaveLength(1);
    close2(); close2(); expect(store.snapshot(a, 'a')?.positions).toEqual([]);
  });
  it('cannot revive an explicitly closed visit with a late or replayed heartbeat', () => {
    const store = new CitizenPresenceStore(); store.connect(a); store.update(a, 'a', fix());
    store.leave(a, 'a'); store.leave(a, 'a'); expect(store.update(a, 'a', fix())).toBe(409);
    expect(store.update(a, 'resumed-new-visit', fix())).toBe(200);
    store.leave(a, 'not-yet-committed'); expect(store.update(a, 'not-yet-committed', fix())).toBe(409);
  });
  it('bounds visits and rejects backwards GPS updates without overwriting current data', () => {
    const store = new CitizenPresenceStore(); store.connect(a);
    for (let i = 0; i < 3; i++) expect(store.update(a, String(i), fix())).toBe(200);
    expect(store.update(a, 'fourth', fix())).toBe(429);
    expect(store.update(a, '0', fix(100, 999))).toBe(409);
  });
  it('bounds total current visits without silently evicting other participants', () => {
    const store = new CitizenPresenceStore();
    for (let i = 0; i < 100; i++) { const actor = { sub: String(i), sessionId: String(i) }; store.connect(actor); expect(store.update(actor, 'v', fix())).toBe(200); }
    store.connect(a); expect(store.update(a, 'a', fix())).toBe(429);
  });
  it('keeps disabled defaults and requires an explicit production topology acknowledgement', () => {
    expect(() => validateCitizenPresenceConfiguration({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => validateCitizenPresenceConfiguration({ CITIZEN_PRESENCE_ENABLED: 'yes' })).toThrow();
    expect(() => validateCitizenPresenceConfiguration({ NODE_ENV: 'production', CITIZEN_PRESENCE_ENABLED: 'true' })).toThrow();
    expect(() => validateCitizenPresenceConfiguration({ NODE_ENV: 'production', CITIZEN_PRESENCE_ENABLED: 'true', CITIZEN_PRESENCE_TOPOLOGY: 'single-process' })).not.toThrow();
  });
});
