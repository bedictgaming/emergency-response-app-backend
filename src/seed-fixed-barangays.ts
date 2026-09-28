import { prisma } from "@/lib/prisma";
import { BarangayStatus, Role } from "@/generated/prisma";

const FIXED_BARANGAYS = [
  "Alegria",
  "Bangbang",
  "Buagsong",
  "Catarman",
  "Cogon",
  "Dapitan",
  "Day-as",
  "Gabi",
  "Gilutongan",
  "Ibabao",
  "Pilipog",
  "Poblacion",
  "San Miguel",
];

async function seedFixedBarangays() {
  console.log("Seeding 13 fixed barangays according to master prompts...");

  const barangayMap: Record<string, string> = {};

  for (const name of FIXED_BARANGAYS) {
    const existing = await prisma.barangay.findUnique({ where: { name } });
    if (!existing) {
      const created = await prisma.barangay.create({
        data: {
          name,
          status: BarangayStatus.ACTIVE,
        },
      });
      barangayMap[name] = created.barangayId;
      console.log(`Created Barangay: ${name}`);
    } else {
      barangayMap[name] = existing.barangayId;
      console.log(`Found existing Barangay: ${name}`);
    }
  }

  // Find admin user
  const admin = await prisma.user.findFirst({ where: { role: Role.ADMIN } });
  if (!admin) {
    console.log("No admin found for incident associations.");
    return;
  }

  // Ensure canonical incident types
  const defaultTypes = [
    { typeName: "Fire Outbreak", description: "Residential, commercial, and forest fires" },
    { typeName: "Medical Emergency", description: "Cardiac arrests, trauma, accidents, and acute medical distress" },
    { typeName: "Police & Security", description: "Civil disturbance, theft, traffic accident, and security incidents" },
    { typeName: "Natural Hazard & Flood", description: "Flash floods, typhoons, landslides, and storm surges" },
  ];

  const typeMap: Record<string, string> = {};
  for (const t of defaultTypes) {
    const existing = await prisma.incidentType.findFirst({ where: { typeName: t.typeName } });
    if (existing) {
      typeMap[t.typeName] = existing.typeId;
    } else {
      const created = await prisma.incidentType.create({ data: t });
      typeMap[t.typeName] = created.typeId;
    }
  }

  // Ensure default location
  let defaultLocation = await prisma.location.findFirst();
  if (!defaultLocation) {
    defaultLocation = await prisma.location.create({
      data: {
        locationName: "Central Emergency Station",
        city: "Cordova",
        province: "Cebu",
      },
    });
  }

  // Link any unassigned incidents to Poblacion
  const poblacionId = barangayMap["Poblacion"];
  if (poblacionId) {
    await prisma.incident.updateMany({
      where: { barangayId: null },
      data: { barangayId: poblacionId },
    });
  }

  console.log("Seeding of 13 fixed barangays and incident types complete!");
}

seedFixedBarangays()
  .catch((e) => console.error("Error seeding fixed barangays", e))
  .finally(async () => {
    await prisma.$disconnect();
  });
