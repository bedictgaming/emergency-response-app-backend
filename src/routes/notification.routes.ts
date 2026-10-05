import { Router } from "express";
import { z } from "zod";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { validateSchema } from "@/middlewares/validate.schema";
import { JwtPayload } from "@/lib/jwt";
import { prisma } from "@/lib/prisma";
import { ENV } from "@/config/env";
import rateLimit from "express-rate-limit";
import { MAX_PUSH_DEVICES_PER_USER, parsePushSubscription } from "@/lib/push-subscription";
import { notificationRelevant, notificationAudience } from '@/lib/notification-relevance';

const router = Router();
const auth = new AuthMiddleware();
router.get('/v1/:id/relevance', auth.execute, async (req, res) => {
  if (!z.uuid().safeParse(req.params.id).success) return res.status(400).json({ message: 'Invalid notification' });
  const job = await prisma.notificationOutbox.findUnique({ where: { notificationOutboxId: String(req.params.id) } });
  if (!job || !notificationAudience(job).includes((req.user as JwtPayload).sub)) return res.status(404).json({ message: 'Notification unavailable' });
  return res.json({ relevant: await notificationRelevant(job, (req.user as JwtPayload).sub) });
});
// The VAPID public key is intentionally public. Browsers need it before they
// can create a subscription, and exposing it does not grant notification
// access. Subscription registration remains authenticated below.
router.get("/v1/web-push-key", (_req, res) => {
  const enabled = Boolean(ENV.WEB_PUSH_PUBLIC_KEY && ENV.WEB_PUSH_PRIVATE_KEY);
  // Push is optional in local/staging environments. Report capability as data
  // instead of emitting a 503 that Axios retries and pino logs as a server error.
  return res.status(200).json({
    code: 200,
    status: "success",
    data: { enabled, publicKey: enabled ? ENV.WEB_PUSH_PUBLIC_KEY : null },
  });
});
const schema = z.object({ body: z.object({ token: z.string().min(20).max(4096), platform: z.literal("web") }) });
const subscriptionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30,
  keyGenerator: (req) => (req.user as JwtPayload).sub,
  standardHeaders: "draft-8", legacyHeaders: false,
  message: { code: 429, status: "error", message: "Too many notification subscription changes. Try again later." },
});

router.post("/v1/device-token", auth.execute, subscriptionLimiter, validateSchema(schema), async (req, res) => {
  const userId = (req.user as JwtPayload).sub;
  try { parsePushSubscription(req.body.token); }
  catch { return res.status(400).json({ code: 400, status: "error", message: "Invalid or unsupported browser push subscription" }); }
  const deviceToken = await prisma.$transaction(async (tx) => {
    // Serialize quota checks for this user; concurrent registration cannot exceed
    // the limit. Keep raw JSON for compatibility with existing unsubscribe calls.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const existing = await tx.deviceToken.findUnique({ where: { token: req.body.token } });
    if (existing?.userId !== userId && await tx.deviceToken.count({ where: { userId, platform: "web" } }) >= MAX_PUSH_DEVICES_PER_USER) return null;
    return tx.deviceToken.upsert({
      where: { token: req.body.token },
      update: { userId, platform: req.body.platform },
      create: { userId, token: req.body.token, platform: req.body.platform },
    });
  });
  if (!deviceToken) return res.status(429).json({ code: 429, status: "error", message: "Notification device limit reached. Unsubscribe an old device first." });
  res.status(200).json({ code: 200, status: "success", data: { deviceTokenId: deviceToken.deviceTokenId } });
});

router.delete("/v1/device-token", auth.execute, validateSchema(z.object({ body: z.object({ token: z.string().min(20).max(4096) }) })), async (req, res) => {
  const userId = (req.user as JwtPayload).sub;
  await prisma.deviceToken.deleteMany({ where: { token: req.body.token, userId } });
  res.status(204).end();
});

export default router;
