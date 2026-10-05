import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  countIncidents: vi.fn(),
  findIncident: vi.fn(),
  findIncidentType: vi.fn(),
  findIncidentTypeByName: vi.fn(),
  upsertIncidentType: vi.fn(),
  findLocation: vi.fn(),
  findAttachment: vi.fn(),
  findAttachmentByPublicId: vi.fn(),
  findBarangayById: vi.fn(),
  createIncident: vi.fn(),
  updateIncident: vi.fn(),
  claimIncident: vi.fn(),
  createAudit: vi.fn(),
  findResponders: vi.fn(),
  findStaff: vi.fn(),
  sendPush: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  findNearbyIncidents: vi.fn(),
  transaction: vi.fn(),
  publish: vi.fn(),
  verifyAsset: vi.fn(),
  deleteImage: vi.fn(),
  enqueueNotification: vi.fn(),
  enqueueCleanup: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.findUser },
    incident: { findUnique: mocks.findIncident, count: mocks.countIncidents },
    incidentType: {
      findUnique: mocks.findIncidentType,
      findFirst: mocks.findIncidentTypeByName,
      upsert: mocks.upsertIncidentType,
    },
    location: { findUnique: mocks.findLocation },
    attachment: {
      findFirst: mocks.findAttachment,
      findUnique: mocks.findAttachmentByPublicId,
    },
    auditLog: { create: mocks.createAudit },
    responder: { findMany: mocks.findResponders },
    barangay: { findUnique: mocks.findBarangayById },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/events", () => ({ publishEmergencyEvent: mocks.publish }));
vi.mock("@/lib/push", () => ({ sendPushNotification: mocks.sendPush }));
vi.mock("@/lib/cloudinary", () => ({
  verifyUploadedAsset: mocks.verifyAsset,
  deleteImage: mocks.deleteImage,
}));
vi.mock("@/lib/jobs", () => ({
  enqueueNotification: mocks.enqueueNotification,
  enqueueAssetCleanup: mocks.enqueueCleanup,
}));

import { CreateIncidentService } from "@/services/incident/create-incident-service";
import { VerifyIncidentService } from "@/services/incident/verify-incident-service";

describe("incident workflow services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countIncidents.mockResolvedValue(0);
    mocks.findAttachment.mockResolvedValue(null);
    mocks.findAttachmentByPublicId.mockResolvedValue(null);
    mocks.deleteImage.mockResolvedValue(undefined);
    mocks.createAudit.mockResolvedValue({});
    mocks.findResponders.mockResolvedValue([]);
    mocks.findStaff.mockResolvedValue([]);
    mocks.findBarangayById.mockResolvedValue({ name: "Poblacion", status: "ACTIVE" });
    mocks.enqueueNotification.mockResolvedValue(undefined);
    mocks.enqueueCleanup.mockResolvedValue(undefined);
    mocks.sendPush.mockResolvedValue({ sent: 0 });
    mocks.queryRaw.mockResolvedValue([]);
    mocks.executeRaw.mockResolvedValue(0);
    mocks.findNearbyIncidents.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (callback) => callback({
      incident: { updateMany: mocks.claimIncident, findUniqueOrThrow: mocks.updateIncident },
      auditLog: { create: mocks.createAudit },
    }));
    mocks.claimIncident.mockResolvedValue({ count: 1 });
  });

  it("returns conflict without audit or notification when another verifier wins", async () => {
    mocks.findIncident.mockResolvedValue({ incidentId: "incident-id", verificationStatus: "PENDING" });
    mocks.claimIncident.mockResolvedValue({ count: 0 });
    const result = await VerifyIncidentService("incident-id", { verificationStatus: "VERIFIED" }, "dispatcher-id");
    expect(result.code).toBe(409);
    expect(mocks.createAudit).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("refuses a citizen report without proof before writing an incident", async () => {
    mocks.findUser.mockResolvedValue({ role: "USER" });
    const result = await CreateIncidentService({ title: "House fire" }, "citizen-id");
    expect(result.code).toBe(400);
    expect(mocks.createIncident).not.toHaveBeenCalled();
  });

  it.each(['091712345678', '09abc123456', '+639171234567', '09 171 234 567', '1e10', '', '１２３'])
    ('rejects invalid citizen contact %j before verifying evidence or writing', async (reporterPhone) => {
      mocks.findUser.mockResolvedValue({ role: "USER" });
      const result = await CreateIncidentService({
        title: "Synthetic contact validation",
        reporterPhone,
        proofAttachment: { publicId: "emergency-incidents/citizen-id/test", fileName: "test.png" },
      }, "citizen-id");
      expect(result).toMatchObject({ code: 400, message: "Contact number must contain only numbers, up to 11 digits" });
      expect(mocks.verifyAsset).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.createIncident).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.enqueueNotification).not.toHaveBeenCalled();
    });

  it.each(['0', '123', '09171234567'])('valid citizen contact %j still requires evidence', async (reporterPhone) => {
    mocks.findUser.mockResolvedValue({ role: "USER" });
    const result = await CreateIncidentService({ title: "Synthetic contact validation", reporterPhone }, "citizen-id");
    expect(result).toMatchObject({ code: 400, message: "A verified proof photo is required for citizen reports" });
    expect(mocks.createIncident).not.toHaveBeenCalled();
  });

  it("rejects a citizen-provided duplicate override reason", async () => {
    mocks.findUser.mockResolvedValue({ role: "USER" });
    mocks.verifyAsset.mockResolvedValue({
      url: "https://example.test/citizen.png",
      publicId: "emergency-incidents/citizen-id/citizen",
      format: "png",
      bytes: 100,
      width: 10,
      height: 10,
    });
    mocks.findIncidentType.mockResolvedValue({ typeId: "type-id", typeName: "Fire" });
    const result = await CreateIncidentService({
      title: "Citizen override attempt",
      typeId: "type-id",
      duplicateOverrideReason: "I want to bypass the duplicate protection",
      proofAttachment: { publicId: "emergency-incidents/citizen-id/citizen", fileName: "citizen.png" },
    }, "citizen-id");
    expect(result.code).toBe(403);
    expect(mocks.createIncident).not.toHaveBeenCalled();
  });

  it("sends a new incident directly to the responding workflow", async () => {
    mocks.findUser.mockResolvedValue({ role: "ADMIN", department: "MAIN", isMainAdmin: true });
    mocks.findIncidentType.mockResolvedValue({ typeId: "type-id", typeName: "Fire" });
    mocks.findLocation.mockResolvedValue({ locationId: "location-id" });
    mocks.createIncident.mockImplementation(async ({ data }) => ({ incidentId: "new-incident", ...data }));
    mocks.transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.queryRaw,
      incident: { findFirst: vi.fn().mockResolvedValue(null), create: mocks.createIncident },
      responder: { findMany: mocks.findResponders },
      user: { findMany: mocks.findStaff },
      auditLog: { create: mocks.createAudit },
    }));

    const result = await CreateIncidentService({
      title: "House fire",
      typeId: "type-id",
      locationId: "location-id",
      barangayId: "barangay-id",
      reporterPhone: "+63 917 123 4567",
    }, "operator-id");

    expect(result.code).toBe(201);
    expect(mocks.createIncident).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "RESPONDING",
        verificationStatus: "VERIFIED",
        verifiedAt: expect.any(Date),
        description: "[Contact: +63 917 123 4567]",
      }),
    }));
  });

  it("blocks a citizen's third report until the next Manila day", async () => {
    mocks.findUser.mockResolvedValue({ role: "USER" });
    mocks.countIncidents.mockResolvedValue(2);
    mocks.verifyAsset.mockResolvedValue({
      url: "https://example.test/third.png",
      publicId: "emergency-incidents/citizen-id/third",
      format: "png",
      bytes: 100,
      width: 10,
      height: 10,
    });

    const result = await CreateIncidentService({
      title: "Third emergency",
      proofAttachment: { publicId: "evidence/citizen-id/third", fileName: "third.png" },
    }, "citizen-id");

    expect(result.code).toBe(429);
    expect(result.message).toContain("daily limit of 2");
    expect(mocks.verifyAsset).toHaveBeenCalledOnce();
    expect(mocks.enqueueCleanup).toHaveBeenCalledWith(expect.anything(), "emergency-incidents/citizen-id/third");
    expect(mocks.createIncident).not.toHaveBeenCalled();
  });

  it("scopes duplicate-photo protection to the citizen who submitted it", async () => {
    mocks.findUser.mockResolvedValue({ role: "USER" });
    mocks.verifyAsset.mockResolvedValue({
      url: "https://example.test/reused.png",
      publicId: "emergency-incidents/citizen-id/reused",
      format: "png",
      bytes: 100,
      width: 10,
      height: 10,
      phash: "same-photo-hash",
    });
    mocks.findAttachment.mockResolvedValue({ incidentId: "previous-incident" });

    const result = await CreateIncidentService({
      title: "Reused evidence",
      proofAttachment: { publicId: "emergency-incidents/citizen-id/reused", fileName: "reused.png" },
    }, "citizen-id");

    expect(mocks.findAttachment).toHaveBeenCalledWith({
      where: { perceptualHash: "same-photo-hash", uploadedBy: "citizen-id" },
      select: { incidentId: true },
    });
    expect(result).toMatchObject({ code: 409, message: "You already used this proof photo for another incident" });
    expect(mocks.enqueueCleanup).toHaveBeenCalledWith(expect.anything(), "emergency-incidents/citizen-id/reused");
  });

  it("never deletes a rejected Cloudinary asset that is already referenced", async () => {
    mocks.findUser.mockResolvedValue({ role: "USER" });
    mocks.verifyAsset.mockResolvedValue({
      url: "https://example.test/existing.png",
      publicId: "emergency-incidents/citizen-id/existing",
      format: "png",
      bytes: 100,
      width: 10,
      height: 10,
      phash: "existing-photo-hash",
    });
    mocks.findAttachment.mockResolvedValue({ incidentId: "previous-incident" });
    mocks.findAttachmentByPublicId.mockResolvedValue({ attachmentId: "existing-attachment" });

    const result = await CreateIncidentService({
      title: "Existing evidence",
      proofAttachment: { publicId: "emergency-incidents/citizen-id/existing", fileName: "existing.png" },
    }, "citizen-id");

    expect(result.code).toBe(409);
    expect(mocks.enqueueCleanup).not.toHaveBeenCalled();
  });

  it("allows a citizen's second report when it is outside the nearby duplicate radius", async () => {
    mocks.findUser.mockResolvedValue({ role: "USER" });
    mocks.countIncidents.mockResolvedValue(1);
    mocks.verifyAsset.mockResolvedValue({
      url: "https://example.test/second.png",
      publicId: "emergency-incidents/citizen-id/second",
      format: "png",
      bytes: 100,
      width: 10,
      height: 10,
    });
    mocks.findIncidentType.mockResolvedValue({ typeId: "type-id", typeName: "Fire" });
    mocks.findLocation.mockResolvedValue({ locationId: "location-id" });
    mocks.createIncident.mockImplementation(async ({ data }) => ({ incidentId: "second-incident", ...data }));
    mocks.transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.queryRaw,
      $executeRaw: mocks.executeRaw,
      incident: {
        count: vi.fn().mockResolvedValue(1),
        findMany: mocks.findNearbyIncidents,
        create: mocks.createIncident,
      },
      responder: { findMany: mocks.findResponders },
      user: { findMany: mocks.findStaff },
      auditLog: { create: mocks.createAudit },
    }));

    const result = await CreateIncidentService({
      title: "Second emergency",
      typeId: "type-id",
      locationId: "location-id",
      barangayId: "barangay-id",
      latitude: 10.251,
      longitude: 123.949,
      reporterPhone: "09171234567",
      proofAttachment: { publicId: "emergency-incidents/citizen-id/second", fileName: "second.png" },
    }, "citizen-id");

    expect(result.code).toBe(201);
    expect(mocks.createIncident).toHaveBeenCalledOnce();
    expect(mocks.createIncident).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: "[Contact: 09171234567]" }),
    }));
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.queryRaw.mock.calls[1][0].join(" ")).toContain("WITH RECURSIVE lock_sequence");
    expect(mocks.queryRaw.mock.calls[1][1]).toHaveLength(9);
    expect(mocks.queryRaw.mock.calls[1][1]).toEqual([...mocks.queryRaw.mock.calls[1][1]].sort());
    expect(mocks.queryRaw.mock.calls[1].slice(1)).toEqual([
      mocks.queryRaw.mock.calls[1][1], mocks.queryRaw.mock.calls[1][1], mocks.queryRaw.mock.calls[1][1],
    ]);
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("rejects a nearby active incident without consuming another report", async () => {
    mocks.findUser.mockResolvedValue({ role: "USER" });
    mocks.verifyAsset.mockResolvedValue({
      url: "https://example.test/nearby.png",
      publicId: "emergency-incidents/citizen-id/nearby",
      format: "png",
      bytes: 100,
      width: 10,
      height: 10,
    });
    mocks.findIncidentType.mockResolvedValue({ typeId: "type-id", typeName: "Fire" });
    mocks.findLocation.mockResolvedValue({ locationId: "location-id" });
    mocks.findNearbyIncidents.mockResolvedValue([{
      incidentId: "existing-incident",
      typeId: "type-id",
      title: "Existing fire",
      status: "ACTIVE",
      reportedAt: new Date("2026-09-13T01:00:00Z"),
      latitude: 10.25105,
      longitude: 123.94905,
      requestedServices: [],
      type: { typeName: "Fire" },
    }]);
    const transactionCount = vi.fn().mockResolvedValue(1);
    mocks.transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.queryRaw,
      $executeRaw: mocks.executeRaw,
      incident: {
        count: transactionCount,
        findMany: mocks.findNearbyIncidents,
        create: mocks.createIncident,
      },
      responder: { findMany: mocks.findResponders },
      user: { findMany: mocks.findStaff },
      auditLog: { create: mocks.createAudit },
    }));

    const result = await CreateIncidentService({
      title: "Another fire report",
      typeId: "type-id",
      locationId: "location-id",
      barangayId: "barangay-id",
      latitude: 10.251,
      longitude: 123.949,
      proofAttachment: { publicId: "emergency-incidents/citizen-id/nearby", fileName: "nearby.png" },
    }, "citizen-id");

    expect(result).toMatchObject({
      code: 409,
      errorCode: "DUPLICATE_ACTIVE_INCIDENT",
      message: expect.stringContaining("already been reported nearby"),
    });
    expect(result).not.toHaveProperty("data");
    expect(transactionCount).toHaveBeenCalledOnce();
    expect(mocks.createIncident).not.toHaveBeenCalled();
    expect(mocks.createAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "citizen-id",
        action: "INCIDENT_DUPLICATE_REJECTED",
        entityId: "existing-incident",
      }),
    });
    expect(mocks.enqueueCleanup).toHaveBeenCalledWith(expect.anything(), "emergency-incidents/citizen-id/nearby");
  });

  it("allows an own-department staff override only with an audited reason", async () => {
    mocks.findUser.mockResolvedValue({ role: "ADMIN", department: "FIRE", isMainAdmin: false });
    mocks.findIncidentType.mockResolvedValue({ typeId: "fire-type", typeName: "Fire" });
    mocks.findLocation.mockResolvedValue({ locationId: "location-id" });
    mocks.findNearbyIncidents.mockResolvedValue([{
      incidentId: "existing-incident",
      typeId: "fire-type",
      status: "RESPONDING",
      latitude: 10.25105,
      longitude: 123.94905,
      requestedServices: [],
      type: { typeName: "Fire" },
    }]);
    mocks.createIncident.mockImplementation(async ({ data }) => ({ incidentId: "staff-created", ...data }));
    mocks.transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.queryRaw,
      $executeRaw: mocks.executeRaw,
      incident: { findMany: mocks.findNearbyIncidents, create: mocks.createIncident },
      responder: { findMany: mocks.findResponders },
      user: { findMany: mocks.findStaff },
      auditLog: { create: mocks.createAudit },
    }));
    const request = {
      title: "Second fire in same building",
      typeId: "fire-type",
      locationId: "location-id",
      barangayId: "barangay-id",
      latitude: 10.251,
      longitude: 123.949,
    };

    const refused = await CreateIncidentService(request, "fire-admin-id");
    expect(refused).toMatchObject({ code: 409, errorCode: "DUPLICATE_ACTIVE_INCIDENT" });
    expect(mocks.createIncident).not.toHaveBeenCalled();

    const approved = await CreateIncidentService({
      ...request,
      duplicateOverrideReason: "Separate confirmed fire in another unit",
    }, "fire-admin-id");
    expect(approved.code).toBe(201);
    expect(mocks.createAudit).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "INCIDENT_DUPLICATE_OVERRIDE",
      actorId: "fire-admin-id",
      metadata: { reason: "Separate confirmed fire in another unit" },
    }) });

    mocks.findIncidentType.mockResolvedValue({ typeId: "medical-type", typeName: "Medical" });
    const crossDepartment = await CreateIncidentService({ ...request, typeId: "medical-type" }, "fire-admin-id");
    expect(crossDepartment.code).toBe(403);
    expect(mocks.createIncident).toHaveBeenCalledOnce();
  });

  it("creates one multi-response incident and targets every selected responder service", async () => {
    mocks.findUser.mockResolvedValue({ role: "USER" });
    mocks.verifyAsset.mockResolvedValue({
      url: "https://example.test/storm.png",
      publicId: "emergency-incidents/citizen-id/storm",
      format: "png",
      bytes: 100,
      width: 10,
      height: 10,
    });
    mocks.findIncidentTypeByName.mockResolvedValue({ typeId: "general-type", typeName: "General Emergency" });
    mocks.findLocation.mockResolvedValue({ locationId: "location-id" });
    mocks.findResponders.mockResolvedValue([
      { userId: "medic-user", unit: { unitType: "EMS Ambulance" } },
      { userId: "hazard-user", unit: { unitType: "DRRMO Rescue" } },
      { userId: "police-user", unit: { unitType: "PNP Police" } },
    ]);
    mocks.createIncident.mockImplementation(async ({ data }) => ({ incidentId: "storm-incident", ...data }));
    mocks.transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.queryRaw,
      $executeRaw: mocks.executeRaw,
      incident: {
        count: vi.fn().mockResolvedValue(0),
        findMany: mocks.findNearbyIncidents,
        create: mocks.createIncident,
      },
      responder: { findMany: mocks.findResponders },
      user: { findMany: mocks.findStaff },
      auditLog: { create: mocks.createAudit },
    }));

    const result = await CreateIncidentService({
      title: "Storm with injured residents",
      category: "other",
      requestedServices: ["MEDICAL", "HAZARD"],
      locationId: "location-id",
      barangayId: "barangay-id",
      latitude: 10.251,
      longitude: 123.949,
      proofAttachment: { publicId: "emergency-incidents/citizen-id/storm", fileName: "storm.png" },
    }, "citizen-id");

    expect(result.code).toBe(201);
    expect(mocks.createIncident).toHaveBeenCalledOnce();
    expect(mocks.createIncident).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ requestedServices: ["HAZARD", "MEDICAL"] }),
    }));
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.queryRaw.mock.calls[1][0].join(" ")).toContain("WITH RECURSIVE lock_sequence");
    expect(mocks.queryRaw.mock.calls[1][1]).toHaveLength(18);
    expect(mocks.queryRaw.mock.calls[1][1]).toEqual([...mocks.queryRaw.mock.calls[1][1]].sort());
    expect(mocks.queryRaw.mock.calls[1].slice(1)).toEqual([
      mocks.queryRaw.mock.calls[1][1], mocks.queryRaw.mock.calls[1][1], mocks.queryRaw.mock.calls[1][1],
    ]);
    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(expect.anything(), "INCIDENT_CREATED", expect.objectContaining({
      data: { incidentId: "storm-incident", attentionVersion: '1', serviceAttentionVersion: '1' },
    }), ["medic-user", "hazard-user"]);
  });

  it("allows only the pending-to-verified transition", async () => {
    mocks.findIncident.mockResolvedValue({
      incidentId: "incident-id", title: "Road collision", reportedBy: "citizen-id", verificationStatus: "PENDING",
    });
    mocks.updateIncident.mockResolvedValue({ incidentId: "incident-id", verificationStatus: "VERIFIED" });
    const result = await VerifyIncidentService("incident-id", { verificationStatus: "VERIFIED" }, "dispatcher-id");
    expect(result.code).toBe(200);
    expect(mocks.createAudit).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledWith({ type: "incident.verified", entityId: "incident-id" });

    mocks.findIncident.mockResolvedValue({
      incidentId: "incident-id", title: "Road collision", reportedBy: "citizen-id", verificationStatus: "VERIFIED",
    });
    const repeated = await VerifyIncidentService("incident-id", { verificationStatus: "REJECTED", verificationNotes: "No" }, "dispatcher-id");
    expect(repeated.code).toBe(409);
  });
});
