import "dotenv/config";
import { prisma } from "../src/lib/prisma";

const [testId, startText, endText, confirmation] = process.argv.slice(2);
const name = (() => {
  try {
    const database = new URL(process.env.DATABASE_URL || "");
    const direct = new URL(process.env.DIRECT_URL || "");
    if (database.host !== direct.host || database.pathname !== direct.pathname) return "";
    return decodeURIComponent(database.pathname.slice(1));
  } catch {
    return "";
  }
})();
const start = new Date(startText);
const end = new Date(endText);
if (!/^[0-9a-f-]{36}$/i.test(testId || "")
  || !/^emergency_staging_\d{8}_[a-f0-9]{6}$/.test(name)
  || process.env.CONFIRM_DISPOSABLE_DATABASE !== name
  || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
  || end.getTime() <= start.getTime() || end.getTime() - start.getTime() > 60_000) {
  throw new Error("Exact staging database, test ID, and at-most-60-second creation window are required");
}

try {
  const users = await prisma.user.findMany({
    where: {
      email: { startsWith: "codex-delivery-", endsWith: "@example.invalid" },
      name: { startsWith: "Disposable test " },
      createdAt: { gte: start, lte: end },
    },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);
  const incidents = await prisma.incident.findMany({
    where: { reportedBy: { in: userIds } },
    select: {
      incidentId: true,
      title: true,
      locationId: true,
      attachments: { select: { publicId: true } },
    },
  });
  const types = await prisma.incidentType.findMany({
    where: { typeName: { endsWith: testId } },
    select: { typeId: true },
  });
  const barangay = await prisma.barangay.findFirst({
    where: { name: "Gabi", createdAt: { gte: start, lte: end } },
    select: { barangayId: true },
  });
  console.log({ database: name, testId, users: users.length, incidents: incidents.length, types: types.length, testBarangay: Boolean(barangay) });
  if (users.length !== 12 || types.length !== 5
    || incidents.some((incident) => !incident.title.endsWith(testId))) {
    throw new Error("Fixture shape differs from the expected interrupted delivery test; refusing cleanup");
  }
  if (confirmation !== "--confirm-delete") {
    console.log("Dry run only. Pass --confirm-delete to remove this exact synthetic fixture.");
  } else {
    const incidentIds = incidents.map((incident) => incident.incidentId);
    const locationIds = incidents.map((incident) => incident.locationId);
    const publicIds = incidents.flatMap((incident) => incident.attachments.map((attachment) => attachment.publicId).filter((id): id is string => Boolean(id)));
    await prisma.$transaction(async (tx) => {
      for (const incidentId of incidentIds) {
        await tx.notificationOutbox.deleteMany({ where: { payload: { path: ["data", "incidentId"], equals: incidentId } } });
      }
      await tx.attachment.deleteMany({ where: { incidentId: { in: incidentIds } } });
      await tx.incident.deleteMany({ where: { incidentId: { in: incidentIds } } });
      await tx.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
      await tx.location.deleteMany({ where: { locationId: { in: locationIds } } });
      await tx.assetCleanupJob.deleteMany({ where: { publicId: { in: publicIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.incidentType.deleteMany({ where: { typeId: { in: types.map((type) => type.typeId) } } });
      if (barangay) {
        const references = await tx.incident.count({ where: { barangayId: barangay.barangayId } });
        if (references !== 0) throw new Error("Test barangay is still referenced; refusing cleanup");
        await tx.barangay.delete({ where: { barangayId: barangay.barangayId } });
      }
    }, { timeout: 20_000 });
    console.log("Exact interrupted synthetic delivery fixture removed");
  }
} finally {
  await prisma.$disconnect();
}
