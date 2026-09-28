import "dotenv/config";
import { prisma } from "@/lib/prisma";

const action = process.argv[2];
const expectedDatabase = process.env.CONFIRM_DISPOSABLE_DATABASE;
const activeUrl = process.env.DATABASE_URL;
const applicationDirectUrl = process.env.DIRECT_URL;
const marker = "restore-drill-20260927";
const email = `${marker}@example.invalid`;

function databaseName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return decodeURIComponent(new URL(value).pathname.slice(1)); }
  catch { return undefined; }
}

if (!["seed", "verify", "cleanup"].includes(action || "")
  || !/^emergency_staging_\d{8}_[a-f0-9]{6}$/.test(expectedDatabase || "")
  || databaseName(activeUrl) !== expectedDatabase
  || databaseName(applicationDirectUrl) === expectedDatabase) {
  throw new Error("Restore fixture requires an exact, non-application staging database confirmation");
}

try {
  if (action === "seed") {
    if (await prisma.user.findUnique({ where: { email } })) {
      throw new Error("Restore fixture already exists; refusing to create another");
    }
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, name: "Synthetic restore drill" } });
      const barangay = await tx.barangay.create({ data: { name: `Synthetic ${marker}` } });
      const type = await tx.incidentType.create({ data: { typeName: `Synthetic ${marker}` } });
      const location = await tx.location.create({ data: {
        locationName: "Synthetic restore drill location", city: "Cordova", province: "Cebu",
        latitude: 10.262, longitude: 123.958,
      } });
      await tx.incident.create({ data: {
        title: marker,
        description: "Synthetic backup/restore validation; not an emergency",
        typeId: type.typeId,
        locationId: location.locationId,
        barangayId: barangay.barangayId,
        latitude: 10.262,
        longitude: 123.958,
        severityLevel: "LOW",
        requestedServices: ["FIRE"],
        status: "RESPONDING",
        verificationStatus: "VERIFIED",
        reportedBy: user.id,
        serviceResponses: { create: { service: "FIRE" } },
        attachments: { create: {
          fileName: "synthetic-proof.jpg",
          fileType: "image/jpeg",
          fileUrl: "https://example.invalid/synthetic-proof.jpg",
          uploadedBy: user.id,
        } },
      } });
    });
    console.log("Synthetic relational restore fixture created in confirmed staging database");
  } else {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { reportedIncidents: {
        where: { title: marker },
        include: { serviceResponses: true, attachments: true, location: true, type: true, barangay: true },
      } },
    });
    if (!user || user.reportedIncidents.length !== 1) throw new Error("Synthetic restore fixture is missing or ambiguous");
    const incident = user.reportedIncidents[0];
    if (incident.serviceResponses.length !== 1 || incident.serviceResponses[0].service !== "FIRE"
      || incident.attachments.length !== 1 || incident.attachments[0].uploadedBy !== user.id
      || incident.location.locationName !== "Synthetic restore drill location"
      || incident.type.typeName !== `Synthetic ${marker}`
      || incident.barangay?.name !== `Synthetic ${marker}`) {
      throw new Error("Synthetic restore relationships did not round-trip");
    }
    if (action === "verify") {
      console.log("Synthetic user, incident, service, evidence, location, type, and barangay relationships verified");
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.attachment.deleteMany({ where: { incidentId: incident.incidentId, uploadedBy: user.id } });
        await tx.incidentServiceResponse.deleteMany({ where: { incidentId: incident.incidentId } });
        await tx.incident.delete({ where: { incidentId: incident.incidentId } });
        await tx.location.delete({ where: { locationId: incident.locationId } });
        await tx.incidentType.delete({ where: { typeId: incident.typeId } });
        await tx.barangay.delete({ where: { barangayId: incident.barangayId! } });
        await tx.user.delete({ where: { id: user.id } });
      });
      console.log("Synthetic restore fixture removed from confirmed staging database");
    }
  }
} finally {
  await prisma.$disconnect();
}
