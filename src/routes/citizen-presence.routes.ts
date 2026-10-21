import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AuthMiddleware } from '@/middleware/auth-middleware';
import { permittedRole } from '@/middleware/rbac-middleware';
import { Role } from '@/generated/prisma';
import type { JwtPayload } from '@/lib/jwt';
import { citizenPresenceEnabled } from '@/config/citizen-presence';
import { citizenPresence, PRESENCE_FIX_MAX_AGE_MS, PRESENCE_SHARING } from '@/lib/citizen-presence';
import { resolveBarangayFromCoordinates } from '@/lib/barangay-boundaries';

const router = Router();
const visit = z.object({ visitId: z.uuid(), sharing: z.literal(PRESENCE_SHARING) }).strict();
const heartbeat = z.object({ visitId: z.uuid(), sharing: z.literal(PRESENCE_SHARING), latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(100_000), timestamp: z.number().finite().nonnegative() }).strict();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.use(new AuthMiddleware().execute, permittedRole([Role.USER]));
// An old approximate-area client must never silently inherit permission to
// publish/read exact GPS. Retire v1 rather than reinterpret its consent.
router.get('/v1/capability', (_req, res) => res.json({ data: { enabled: false } }));
router.use('/v1', (_req, res) => res.status(409).json({ message: 'Exact GPS sharing requires a new explicit opt-in' }));
router.get('/v2/capability', (_req, res) => res.json({ data: { enabled: citizenPresenceEnabled(), precision: PRESENCE_SHARING } }));
router.use((_req, res, next) => citizenPresenceEnabled() ? next() : res.status(409).json({ message: 'Online presence is not enabled' }));
router.use(rateLimit({ windowMs: 60_000, limit: 90, keyGenerator: req => (req.user as JwtPayload).sub,
  standardHeaders: 'draft-8', legacyHeaders: false }));
router.post('/v2/heartbeat', (req, res) => {
  const input = heartbeat.safeParse(req.body);
  if (!input.success || input.data.timestamp > Date.now() + 5000 || Date.now() - input.data.timestamp >= PRESENCE_FIX_MAX_AGE_MS
    || !resolveBarangayFromCoordinates('', input.data.latitude, input.data.longitude))
    return res.status(400).json({ message: 'A fresh Cordova GPS fix is required' });
  const { latitude, longitude, accuracy, timestamp } = input.data;
  const code = citizenPresence.update(req.user as JwtPayload, input.data.visitId, { latitude, longitude, accuracy, timestamp });
  if (code !== 200) return res.status(code).json({ message: code === 429 ? 'Presence capacity reached' : 'A current Socket.IO connection is required' });
  return res.json({ data: citizenPresence.snapshot(req.user as JwtPayload, input.data.visitId) });
});
router.post('/v2/nearby', (req, res) => {
  const input = visit.safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Invalid presence request' });
  const data = citizenPresence.snapshot(req.user as JwtPayload, input.data.visitId);
  return data ? res.json({ data }) : res.status(409).json({ message: 'Refresh your foreground presence first' });
});
router.post('/v2/leave', (req, res) => {
  const input = visit.safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Invalid presence request' });
  citizenPresence.leave(req.user as JwtPayload, input.data.visitId);
  return res.status(204).end();
});
export default router;
