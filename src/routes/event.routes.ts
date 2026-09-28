import { Request, Response, Router } from "express";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { subscribeEmergencyEvents } from "@/lib/events";
import { canReceiveEvent } from "@/lib/event-access";
import type { JwtPayload } from "@/lib/jwt";

const router = Router();
const auth = new AuthMiddleware();

const streamEvents = (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: connected\ndata: {"ok":true}\n\n`);

  const unsubscribe = subscribeEmergencyEvents((event) => {
    void canReceiveEvent(req.user as JwtPayload, event).then(allowed => {
      if (allowed && !res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }).catch(() => res.end());
  });
  // Reconnect frequently so expiry, account deactivation and role changes are rechecked.
  const expiry = setTimeout(() => res.end(), 60_000);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(expiry);
    unsubscribe();
  });
};

router.get("/v1/stream", auth.execute, streamEvents);

export default router;
