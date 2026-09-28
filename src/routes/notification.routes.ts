import { Router } from "express";
import { z } from "zod";
import { AuthMiddleware } from "@/middlewares/auth-middleware";
import { validateSchema } from "@/middlewares/validate.schema";
import { JwtPayload } from "@/lib/jwt";
import { prisma } from "@/lib/prisma";
import { ENV } from "@/config/env";

const router = Router();
const auth = new AuthMiddleware();
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

router.post("/v1/device-token", auth.execute, validateSchema(schema), async (req, res) => {
  const userId = (req.user as JwtPayload).sub;
  const deviceToken = await prisma.deviceToken.upsert({
    where: { token: req.body.token },
    update: { userId, platform: req.body.platform },
    create: { userId, token: req.body.token, platform: req.body.platform },
  });
  res.status(200).json({ code: 200, status: "success", data: { deviceTokenId: deviceToken.deviceTokenId } });
});

router.delete("/v1/device-token", auth.execute, validateSchema(z.object({ body: z.object({ token: z.string().min(20).max(4096) }) })), async (req, res) => {
  const userId = (req.user as JwtPayload).sub;
  await prisma.deviceToken.deleteMany({ where: { token: req.body.token, userId } });
  res.status(204).end();
});

export default router;
