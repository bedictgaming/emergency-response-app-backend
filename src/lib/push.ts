import { prisma } from "@/lib/prisma";
import webpush from "web-push";
import { ENV } from "@/config/env";
import { deliverPush, InvalidPushSubscription, parsePushSubscription, PushDeliveryError } from "@/lib/push-subscription";
import { createHash } from 'node:crypto';

type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, string>;
  userIds?: string[];
  deliveredDevices?: string[];
  canDeliver?: (userId: string) => Promise<boolean>;
  beforeDevice?: () => Promise<void>;
  onDelivered?: (key: string) => Promise<void>;
};

export async function sendPushNotification(message: PushMessage) {
  // An explicit empty audience means nobody. Only omitted userIds broadcasts.
  if (message.userIds !== undefined && message.userIds.length === 0) return { sent: 0, skipped: false };
  const devices = await prisma.deviceToken.findMany({
    where: {
      ...(message.userIds !== undefined ? { userId: { in: message.userIds } } : {}),
      platform: "web",
      user: { status: "ACTIVE" },
    },
    select: { token: true, userId: true },
  });
  if (devices.length === 0) return { sent: 0, skipped: false };

  const invalidTokens: Array<{ token: string; userId: string }> = [];
  const retryUserIds = new Set<string>();
  let sent = 0;
  const delivered = new Set(message.deliveredDevices ?? []);
  for (const device of devices) {
    await message.beforeDevice?.();
    // Device ownership may change when another account signs into a shared phone.
    const stillOwned = await prisma.deviceToken.findFirst({ where: { token: device.token, userId: device.userId, user: { status: "ACTIVE" } }, select: { deviceTokenId: true } });
    if (!stillOwned) continue;
    if (message.canDeliver && !await message.canDeliver(device.userId)) continue;
    if (!ENV.WEB_PUSH_PUBLIC_KEY || !ENV.WEB_PUSH_PRIVATE_KEY) { retryUserIds.add(device.userId); continue; }
    let key: string;
    try {
      const subscription = parsePushSubscription(device.token);
      key = createHash('sha256').update(JSON.stringify([device.userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth])).digest('hex');
      if (delivered.has(key)) continue;
      webpush.setVapidDetails(ENV.WEB_PUSH_SUBJECT, ENV.WEB_PUSH_PUBLIC_KEY, ENV.WEB_PUSH_PRIVATE_KEY);
      const notification = message.userIds !== undefined
        ? { title: "Emergency response update", body: "Open the app and sign in to view your update.", data: message.data }
        : { title: message.title, body: message.body, data: message.data };
      await deliverPush(subscription, JSON.stringify(notification));
      // Persist progress before advancing to another device. A lost lease or
      // database error escapes immediately instead of becoming a delivery error.
      sent += 1;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (error instanceof InvalidPushSubscription || statusCode === 400 || statusCode === 404 || statusCode === 410 ||
          (statusCode !== undefined && statusCode >= 300 && statusCode < 400)) {
        invalidTokens.push({ token: device.token, userId: device.userId });
      } else retryUserIds.add(device.userId);
      continue;
    }
    await message.onDelivered?.(key);
    delivered.add(key);
  }
  // Include ownership so a shared-device transfer during delivery isn't erased.
  if (invalidTokens.length) await prisma.deviceToken.deleteMany({ where: { OR: invalidTokens } });
  if (retryUserIds.size) throw new PushDeliveryError([...retryUserIds]);
  return { sent, skipped: false };
}
