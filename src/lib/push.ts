import { prisma } from "@/lib/prisma";
import webpush from "web-push";
import { ENV } from "@/config/env";

type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, string>;
  userIds?: string[];
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

  const invalidTokens: string[] = [];
  let sent = 0;
  for (const device of devices) {
    // Device ownership may change when another account signs into a shared phone.
    const stillOwned = await prisma.deviceToken.findFirst({ where: { token: device.token, userId: device.userId, user: { status: "ACTIVE" } }, select: { deviceTokenId: true } });
    if (!stillOwned) continue;
    if (!ENV.WEB_PUSH_PUBLIC_KEY || !ENV.WEB_PUSH_PRIVATE_KEY) continue;
    webpush.setVapidDetails(ENV.WEB_PUSH_SUBJECT, ENV.WEB_PUSH_PUBLIC_KEY, ENV.WEB_PUSH_PRIVATE_KEY);
    try {
      const notification = message.userIds !== undefined
        ? { title: "Emergency response update", body: "Open the app and sign in to view your update.", data: message.data }
        : { title: message.title, body: message.body, data: message.data };
      await webpush.sendNotification(JSON.parse(device.token), JSON.stringify(notification));
      sent += 1;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) invalidTokens.push(device.token);
      else throw error;
    }
  }
  if (invalidTokens.length) await prisma.deviceToken.deleteMany({ where: { token: { in: invalidTokens } } });
  return { sent, skipped: false };
}
