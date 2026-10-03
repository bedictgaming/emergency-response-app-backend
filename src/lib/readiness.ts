/** A slow database must not hang health probes or create a query storm. */
export function createReadinessCheck(probe: () => Promise<unknown>, timeoutMs = 3000, cacheMs = 1000) {
  let flight: Promise<boolean> | null = null;
  let last: { ready: boolean; until: number } | null = null;
  return () => {
    if (last && Date.now() < last.until) return Promise.resolve(last.ready);
    if (flight) return flight;
    let timer: ReturnType<typeof setTimeout>;
    const query = Promise.resolve().then(probe).then(() => true, () => false);
    const bounded = Promise.race([
      query,
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]).then(ready => {
      clearTimeout(timer);
      last = { ready, until: Date.now() + cacheMs };
      return ready;
    });
    flight = bounded;
    // Timeout does not cancel a pg query. Keep the single-flight guard until
    // it actually settles; later requests get the bounded failure meanwhile.
    void Promise.all([query, bounded]).then(() => { if (flight === bounded) flight = null; });
    return bounded;
  };
}
