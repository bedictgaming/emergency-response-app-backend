import type { Server as HttpServer } from 'node:http';
import express, { type Request, type Response, type RequestHandler, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { AuthMiddleware } from '@/middleware/auth-middleware';
import { originGuard } from '@/middleware/origin-guard';
import { trustedOrigins } from '@/lib/public-origin';
import { ENV } from '@/config/env';
import { prisma } from '@/lib/prisma';
import type { JwtPayload } from '@/lib/jwt';
import { subscribeEmergencyEvents, type EmergencyEvent } from '@/lib/events';
import { presentEmergencyEvent } from '@/lib/present-emergency-event';
import { acquireEmergencyStream } from '@/lib/event-stream-budget';

export const SOCKET_EVENTS_PATH = '/api/events/v1/socket.io';

/** Server-to-browser invalidations only; existing HTTP APIs still own every write. */
export function attachSocketEvents(server: HttpServer, gatewayGuard: RequestHandler) {
  const requestApplication = express();
  requestApplication.disable('x-powered-by');
  requestApplication.disable('etag');
  requestApplication.set('trust proxy', ENV.TRUSTED_PROXY_CIDRS.length ? ENV.TRUSTED_PROXY_CIDRS : false);
  const handshake = express.Router();
  handshake.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // Engine.IO bypasses the normal Express app. Never bypass its gateway/auth boundary.
  // Use the SAME gateway guard instance, including its nonce replay budget.
  handshake.use(gatewayGuard);
  handshake.use(originGuard);
  handshake.use((req, res, next) => {
    if (req.method !== 'GET' || !trustedOrigins.has(req.get('origin') ?? '')) {
      res.status(403).json({ code: 403, status: 'error', message: 'Trusted application origin required' });
      return;
    }
    next();
  });
  handshake.use(cookieParser());
  handshake.use(new AuthMiddleware().execute);
  handshake.use(rateLimit({ windowMs: 60_000, limit: 30,
    keyGenerator: req => (req.user as JwtPayload).sub,
    standardHeaders: 'draft-8', legacyHeaders: false }));

  const io = new Server(server, {
    path: SOCKET_EVENTS_PATH,
    transports: ['websocket'], // No hidden long-polling substitution for WebSocket.
    serveClient: false, maxHttpBufferSize: 1024,
    perMessageDeflate: false, connectTimeout: 10_000,
    // Do not restore rooms/packets while skipping fresh authentication.
  });
  io.engine.use((incoming: unknown, outgoing: unknown, next: NextFunction) => {
    const req = incoming as Request, res = outgoing as Response;
    // Engine.IO's upgrade response is NOT a Node ServerResponse. Running an
    // Express application would replace its prototype and break the upgrade.
    // Adapt only the request and the small response surface our guards use.
    Object.setPrototypeOf(req, requestApplication.request);
    req.app = requestApplication;
    req.res = res;
    req.originalUrl = req.url;
    res.locals ??= {};
    res.status = function(code: number) { this.statusCode = code; return this; };
    res.json = function(body: unknown) { this.setHeader('Content-Type', 'application/json'); this.end(JSON.stringify(body)); return this; };
    res.send = res.json;
    res.append = function(name, value) {
      const prior = this.getHeader(name);
      const additions = Array.isArray(value) ? value : [String(value)];
      this.setHeader(name, prior === undefined ? additions : [...(Array.isArray(prior) ? prior : [String(prior)]), ...additions]);
      return this;
    };
    handshake(req, res, next);
  });
  io.use((socket, next) => {
    const actor = (socket.request as Request).user as JwtPayload | undefined;
    const release = actor && acquireEmergencyStream(actor.sub);
    if (!actor || !release) { next(new Error('Live connection unavailable')); return; }
    socket.data.actor = actor;
    socket.data.release = release;
    // Also release on failed namespace setup or early transport disconnect.
    socket.conn.once('close', release);
    next();
  });
  io.on('connection', socket => {
    const actor = socket.data.actor as JwtPayload;
    let ended = false, checking = false;
    const pending: EmergencyEvent[] = [];
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (ended) return;
      ended = true; pending.length = 0;
      clearInterval(heartbeat); clearTimeout(expiry); unsubscribe();
      (socket.data.release as () => void)();
      socket.disconnect(true);
    };
    const check = async (event?: EmergencyEvent) => {
      if (ended) return;
      if (checking) {
        if (event) { if (pending.length >= 16) finish(); else pending.push(event); }
        return;
      }
      checking = true;
      try {
        const account = await prisma.user.findUnique({ where: { id: actor.sub }, select: {
          role: true, status: true, department: true, isMainAdmin: true,
          tokens: { where: { id: actor.sessionId ?? '', type: 'REFRESH', consumedAt: null,
            revokedAt: null, expiresAt: { gt: new Date() } }, take: 1, select: { id: true } },
        } });
        if (ended) return;
        if (!account || account.status !== 'ACTIVE' || !account.tokens.length
          || (actor.exp ?? 0) <= Date.now() / 1000 || account.role !== actor.role
          || account.department !== actor.department || account.isMainAdmin !== actor.isMainAdmin) {
          finish(); return;
        }
        const outgoing = event ? await presentEmergencyEvent({ ...actor, ...account }, event) : null;
        if (outgoing) {
          if (ended) return;
          if (!socket.conn.transport.writable) {
            finish(); return;
          }
          // No report body, evidence, coordinates, cookies or client-selected rooms.
          socket.emit('emergency.event', outgoing);
        }
      } catch { finish(); }
      finally {
        checking = false;
        const next = pending.shift();
        if (next && !ended) void check(next);
      }
    };
    socket.once('disconnect', finish);
    socket.onAny(() => finish()); // No client commands or room subscriptions.
    unsubscribe = subscribeEmergencyEvents(event => { void check(event); });
    heartbeat = setInterval(() => { void check(); }, 25_000);
    // Same short reauthorization lifetime as SSE, with bounded client reconnect.
    expiry = setTimeout(finish, Math.min(60_000, Math.max(0, (actor.exp ?? 0) * 1000 - Date.now())));
    void check();
  });
  return io;
}
