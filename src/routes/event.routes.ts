import { Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AuthMiddleware } from '@/middlewares/auth-middleware';
import { subscribeEmergencyEvents, type EmergencyEvent } from '@/lib/events';
import { canReceiveEvent } from '@/lib/event-access';
import { prisma } from '@/lib/prisma';
import { createEventStreamBudget } from '@/lib/event-stream-budget';
import type { JwtPayload } from '@/lib/jwt';

const router = Router(), auth = new AuthMiddleware();
const acquire = createEventStreamBudget();
const limiter = rateLimit({ windowMs: 60_000, limit: 30, keyGenerator: req => (req.user as JwtPayload).sub, standardHeaders: 'draft-8', legacyHeaders: false });

const streamEvents = (req: Request, res: Response) => {
  const actor = req.user as JwtPayload, release = acquire(actor.sub);
  if (!release) return res.status(429).json({ message: 'Stream capacity reached; use report refresh and retry shortly.' });
  let ended = false, running = false, pending: EmergencyEvent | undefined;
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval>, expiry: ReturnType<typeof setTimeout>;
  const finish = () => {
    if (ended) return;
    ended = true; pending = undefined; clearInterval(heartbeat); clearTimeout(expiry); unsubscribe(); release(); res.end();
  };
  const write = (value: string) => {
    if (ended || res.destroyed || res.writableEnded) { finish(); return; }
    if (!res.write(value)) finish();
  };
  const check = async (event?: EmergencyEvent) => {
    if (running || ended) { if (event) pending = event; return; }
    running = true;
    try {
      const account = await prisma.user.findUnique({ where: { id: actor.sub }, select: {
        role: true, status: true, department: true, isMainAdmin: true,
        tokens: { where: { id: actor.sessionId ?? '', type: 'REFRESH', consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, take: 1, select: { id: true } },
      } });
      if (!account || account.status !== 'ACTIVE' || !account.tokens.length || (actor.exp ?? 0) <= Date.now() / 1000
        || account.role !== actor.role || account.department !== actor.department || account.isMainAdmin !== actor.isMainAdmin) { finish(); return; }
      const fresh = { ...actor, ...account };
      if (event) { if (await canReceiveEvent(fresh, event)) write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
      else write(': heartbeat\n\n');
    } catch { finish(); }
    finally {
      running = false;
      const next = pending; pending = undefined;
      if (next && !ended) void check(next);
    }
  };
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  write('event: connected\ndata: {"ok":true}\n\n');
  if (ended) return;
  unsubscribe = subscribeEmergencyEvents(event => { void check(event); });
  expiry = setTimeout(finish, 60_000);
  heartbeat = setInterval(() => { void check(); }, 25_000);
  req.on('close', finish); res.on('close', finish); res.on('error', finish);
};
router.get('/v1/stream', auth.execute, limiter, streamEvents);
export default router;
