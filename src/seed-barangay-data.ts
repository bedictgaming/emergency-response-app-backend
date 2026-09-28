import { prisma } from "@/lib/prisma";
import { IncidentStatus, SeverityLevel, Role } from "@/generated/prisma";

async function seedBarangayData() {
  console.log("Seeding Barangay locations, Incident Types, and Historical Incidents...");

  // 1. Ensure canonical locations (Barangays) exist
  const barangays = [
    { locationName: "Barangay Poblacion (Central)", city: "Ormoc City", province: "Leyte", address: "Real Street corner Bonifacio" },
    { locationName: "Barangay San Isidro", city: "Ormoc City", province: "Leyte", address: "National Highway Zone 2" },
    { locationName: "Barangay Cogon", city: "Ormoc City", province: "Leyte", address: "Rizal Avenue Commercial District" },
    { locationName: "Barangay Linao", city: "Ormoc City", province: "Leyte", address: "Linao Coastal Road" },
    { locationName: "Barangay Valencia", city: "Ormoc City", province: "Leyte", address: "Valencia River Road" },
    { locationName: "Barangay Can-adieng", city: "Ormoc City", province: "Leyte", address: "Can-adieng Mountain Slope" },
  ];

  const locationMap: Record<string, string> = {};
  for (const b of barangays) {
    const existing = await prisma.location.findFirst({ where: { locationName: b.locationName } });
    if (existing) {
      locationMap[b.locationName] = existing.locationId;
    } else {
      const created = await prisma.location.create({ data: b });
      locationMap[b.locationName] = created.locationId;
    }
  }

  // 2. Ensure canonical Incident Types exist
  const incidentTypes = [
    { typeName: "Fire Outbreak", description: "Residential, commercial, and forest fires" },
    { typeName: "Medical Emergency", description: "Cardiac arrests, trauma, accidents, and acute medical distress" },
    { typeName: "Police & Security", description: "Civil disturbance, theft, traffic accident, and security incidents" },
    { typeName: "Natural Hazard & Flood", description: "Flash floods, typhoons, landslides, and storm surges" },
  ];

  const typeMap: Record<string, string> = {};
  for (const t of incidentTypes) {
    const existing = await prisma.incidentType.findFirst({ where: { typeName: t.typeName } });
    if (existing) {
      typeMap[t.typeName] = existing.typeId;
    } else {
      const created = await prisma.incidentType.create({ data: t });
      typeMap[t.typeName] = created.typeId;
    }
  }

  // 3. Find admin/user to assign as reporter
  const reporter = await prisma.user.findFirst({ where: { role: Role.ADMIN } });
  if (!reporter) {
    console.error("No admin user found to seed incidents.");
    return;
  }

  // 4. Seed realistic historical incidents
  const sampleIncidents = [
    {
      title: "Commercial Building Structure Fire",
      description: "2nd alarm fire reported in commercial warehouse. BFP Units dispatched.",
      typeName: "Fire Outbreak",
      locationName: "Barangay Poblacion (Central)",
      severityLevel: SeverityLevel.CRITICAL,
      status: IncidentStatus.RESOLVED,
      daysAgo: 2,
    },
    {
      title: "Flash Flood Surge along Riverbank",
      description: "Water levels rose past critical mark due to continuous torrential rain. Evacuation assisted.",
      typeName: "Natural Hazard & Flood",
      locationName: "Barangay Valencia",
      severityLevel: SeverityLevel.HIGH,
      status: IncidentStatus.RESOLVED,
      daysAgo: 4,
    },
    {
      title: "Vehicular Collision with Injuries",
      description: "Motorcycle and delivery van collision. 2 passengers treated by EMS.",
      typeName: "Medical Emergency",
      locationName: "Barangay San Isidro",
      severityLevel: SeverityLevel.MEDIUM,
      status: IncidentStatus.RESOLVED,
      daysAgo: 6,
    },
    {
      title: "Residential Kitchen Fire Outbreak",
      description: "LPG tank leak ignited fire in residential compound. Controlled within 25 minutes.",
      typeName: "Fire Outbreak",
      locationName: "Barangay Poblacion (Central)",
      severityLevel: SeverityLevel.HIGH,
      status: IncidentStatus.RESOLVED,
      daysAgo: 8,
    },
    {
      title: "Civil Disturbance & Traffic Blockade",
      description: "Dispute at market entrance causing severe road congestion. Police unit mediated.",
      typeName: "Police & Security",
      locationName: "Barangay Cogon",
      severityLevel: SeverityLevel.LOW,
      status: IncidentStatus.RESOLVED,
      daysAgo: 10,
    },
    {
      title: "Cardiac Arrest Emergency Call",
      description: "Elderly patient collapsed at barangay hall. Paramedics performed CPR en route to hospital.",
      typeName: "Medical Emergency",
      locationName: "Barangay Linao",
      severityLevel: SeverityLevel.CRITICAL,
      status: IncidentStatus.RESOLVED,
      daysAgo: 12,
    },
    {
      title: "Grassland Fire near Highway",
      description: "Dry season brush fire spreading near power lines. Extinguished by BFP tanker.",
      typeName: "Fire Outbreak",
      locationName: "Barangay Poblacion (Central)",
      severityLevel: SeverityLevel.MEDIUM,
      status: IncidentStatus.RESOLVED,
      daysAgo: 15,
    },
    {
      title: "Storm Surge Flooding in Coastal Area",
      description: "High tide combined with storm winds breached sea wall. Responders deployed sandbags.",
      typeName: "Natural Hazard & Flood",
      locationName: "Barangay Linao",
      severityLevel: SeverityLevel.HIGH,
      status: IncidentStatus.RESOLVED,
      daysAgo: 18,
    },
    {
      title: "Active Structural Fire on Rizal Ave",
      description: "Ongoing fire investigation and perimeter security in effect.",
      typeName: "Fire Outbreak",
      locationName: "Barangay Poblacion (Central)",
      severityLevel: SeverityLevel.HIGH,
      status: IncidentStatus.ACTIVE,
      daysAgo: 0,
    },
  ];

  for (const s of sampleIncidents) {
    const locId = locationMap[s.locationName];
    const typeId = typeMap[s.typeName];
    if (!locId || !typeId) continue;

    const reportedDate = new Date(Date.now() - s.daysAgo * 24 * 60 * 60 * 1000);

    const existing = await prisma.incident.findFirst({ where: { title: s.title } });
    if (!existing) {
      await prisma.incident.create({
        data: {
          title: s.title,
          description: s.description,
          typeId,
          locationId: locId,
          severityLevel: s.severityLevel,
          status: s.status,
          reportedBy: reporter.id,
          reportedAt: reportedDate,
          updatedAt: reportedDate,
        },
      });
    }
  }

  console.log("Barangay data seeding completed successfully!");
}

seedBarangayData()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
