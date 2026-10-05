import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../../emergency-response-app-frontend/public/sw.js', import.meta.url), 'utf8');
function worker(receipts = new Map<string, number>(), relevant: boolean | 'offline' = true, receiptMode: 'normal' | 'abort' = 'normal') {
  const handlers: Record<string, (event: any) => void> = {};
  const shown = vi.fn().mockResolvedValue(undefined), fetched = vi.fn();
  const indexedDB = { open: () => {
    const open: any = {};
    const db = { close() {}, transaction: () => {
      const tx: any = {};
      if (receiptMode === 'abort') {
        tx.objectStore = () => ({ get: () => ({}), put: () => {}, openCursor: () => ({}) });
        setTimeout(() => tx.onabort(), 0);
        return tx;
      }
      const store = {
        get: (id: string) => { const result: any = {}; setTimeout(() => { result.result = receipts.get(id); result.onsuccess(); tx.oncomplete(); }, 0); return result; },
        put: (value: number, id: string) => receipts.set(id, value),
        openCursor: () => {
          const keys = [...receipts.keys()]; const result: any = {}; let index = 0;
          const next = () => setTimeout(() => {
            const key = keys[index++]; result.result = key ? { value: receipts.get(key), delete: () => receipts.delete(key), continue: next } : null;
            result.onsuccess(); if (!key) tx.oncomplete();
          }, 0);
          next(); return result;
        },
      }; tx.objectStore = () => store; return tx;
    } }; setTimeout(() => { open.result = db; open.onsuccess(); }, 0); return open;
  } };
  runInNewContext(source, { indexedDB, URL, Date, Promise, AbortController, setTimeout, clearTimeout,
    fetch: fetched.mockImplementation(async () => { if (relevant === 'offline') throw new Error('Offline'); return { ok: true, status: 200, json: async () => ({ relevant }) }; }),
    self: { location: { origin: 'https://app.example.test' }, addEventListener: (name: string, handler: any) => { handlers[name] = handler; }, registration: { showNotification: shown, getNotifications: async () => [] } },
  });
  const push = async (id: string, extra = {}) => {
    let done!: Promise<void>;
    handlers.push({ data: { json: () => ({ title: 'Private title', body: 'Private address', data: { notificationId: id, expiresAt: new Date(Date.now() + 60000).toISOString(), ...extra } }) }, waitUntil: (value: Promise<void>) => { done = value; } });
    await done;
  };
  return { push, shown, fetched };
}
const id = '00000000-0000-0000-0000-000000000001';
it('does not display expired or currently irrelevant push hints', async () => {
  const live = worker(); await live.push(id, { expiresAt: new Date(Date.now() - 1).toISOString() }); expect(live.shown).not.toHaveBeenCalled(); expect(live.fetched).not.toHaveBeenCalled();
  const resolved = worker(undefined, false); await resolved.push(id); expect(resolved.shown).not.toHaveBeenCalled();
});
it('keeps receipt deduplication across service-worker restarts without storing payloads', async () => {
  const receipts = new Map<string, number>(), first = worker(receipts); await first.push(id); await first.push(id); expect(first.shown).toHaveBeenCalledOnce();
  const restarted = worker(receipts); await restarted.push(id); expect(restarted.shown).not.toHaveBeenCalled();
  expect(receipts.size).toBe(1); expect([...receipts.values()][0]).toBeTypeOf('number');
});
it('preserves a neutral hint during a network outage rather than announcing a confirmed emergency or silently discarding work', async () => {
  const offline = worker(undefined, 'offline'); await offline.push(id);
  expect(offline.shown).toHaveBeenCalledWith('Emergency response update', expect.objectContaining({ body: 'An update is waiting. Sign in to check its current status.' }));
  expect(JSON.stringify(offline.shown.mock.calls)).not.toContain('Private address');
});
it('receipt-storage abort does not hang or suppress a potentially genuine update', async () => {
  const current = worker(undefined, 'offline', 'abort');
  await current.push(id);
  expect(current.shown).toHaveBeenCalledOnce();
  expect(current.shown).toHaveBeenCalledWith('Emergency response update', expect.objectContaining({ body: 'An update is waiting. Sign in to check its current status.' }));
});
it('uses separate notification identities for independent advisories and rejects off-origin click destinations', async () => {
  const current = worker(); await current.push(id, { alertId: 'advisory-a', url: 'https://evil.example.test' });
  await current.push('00000000-0000-0000-0000-000000000002', { alertId: 'advisory-b' });
  expect(current.shown.mock.calls[0][1].tag).not.toBe(current.shown.mock.calls[1][1].tag);
  expect(current.shown.mock.calls[0][1].data.url).toBe('https://app.example.test/dashboard');
});
