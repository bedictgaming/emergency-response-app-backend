/**
 * Real Express + PostgreSQL + SSE workflow test. The external photo verifier is
 * deliberately synthetic; run only through `npm run test:delivery` on an
 * isolated, already-migrated disposable database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { performance } from "node:perf_hooks";

vi.mock("@/lib/cloudinary", async (load) => {
  const actual = await load<typeof import("@/lib/cloudinary")>();
  return {
    ...actual,
    verifyUploadedAsset: async (publicId: string, userId: string) => {
      if (!publicId.startsWith(`emergency-incidents/${userId}/test-`)) {
        throw new Error("Invalid test evidence owner");
      }
      return {
        publicId,
        url: `https://evidence.invalid/${encodeURIComponent(publicId)}`,
        format: "jpg",
        bytes: 1024,
        width: 100,
        height: 100,
        phash: publicId,
        moderationStatus: "approved",
      };
    },
  };
});

import app from "@/app";
import { prisma } from "@/lib/prisma";
import { ENV } from "@/config/env";
import { hashPassword } from "@/utils/password";
import { resolveBarangayFromCoordinates } from "@/lib/barangay-boundaries";

type Account = { id: string; email: string; cookie: string };
type StreamEvent = { type: string; entityId: string; receivedAt: number };
type Stream = { events: StreamEvent[]; close: () => Promise<void> };

const run = process.env.RUN_DISPOSABLE_DELIVERY_TESTS === "1";
const suite = describe.runIf(run);
const testId = randomUUID();
const testPassword = `Codex-test-${randomUUID()}!`;
const userIds: string[] = [];
const incidentIds: string[] = [];
const locationIds: string[] = [];
const publicIds: string[] = [];
const streams: Stream[] = [];
const typeIds: string[] = [];
let server: Server;
let base = "";
let barangayId = "";
let createdBarangayId = "";
let generalTypeId = "";
let fireTypeId = "";
let citizen: Account;
let raceCitizenA: Account;
let raceCitizenB: Account;
let singleCitizens: Account[] = [];
let main: Account;
let medical: Account;
let hazard: Account;
let fire: Account;
let police: Account;
const singleTypes: Partial<Record<"FIRE" | "MEDICAL" | "POLICE" | "HAZARD", string>> = {};

function checkDisposableTarget() {
  const supplied = process.env.DISPOSABLE_DATABASE_URL;
  const current = process.env.DATABASE_URL;
  const name = supplied ? decodeURIComponent(new URL(supplied).pathname.slice(1)) : "";
  if (!supplied || current !== supplied || process.env.CONFIRM_DISPOSABLE_DATABASE !== name
    || !/(?:test|staging|disposable)/i.test(name)) {
    throw new Error("Disposable database confirmation is missing; refusing integration writes");
  }
}

async function jsonRequest(path: string, options: { method?: string; cookie?: string; body?: unknown } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.cookie && { Cookie: options.cookie }),
      ...(options.body && { "Content-Type": "application/json" }),
      ...(options.method && options.method !== "GET" && { Origin: ENV.FRONTEND_URL }),
    },
    ...(options.body && { body: JSON.stringify(options.body) }),
  });
  return { response, body: await response.json() as Record<string, any> };
}

async function createAccount(role: "USER" | "ADMIN", department?: "MAIN" | "FIRE" | "MEDICAL" | "POLICE" | "DRRMO") {
  const email = `codex-delivery-${randomUUID()}@example.invalid`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Disposable test ${role}`,
      password: await hashPassword(testPassword),
      emailVerified: new Date(),
      role,
      department,
      isMainAdmin: department === "MAIN",
    },
    select: { id: true },
  });
  userIds.push(user.id);
  const response = await fetch(`${base}/api/auth/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ENV.FRONTEND_URL },
    body: JSON.stringify({ email, password: testPassword }),
  });
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  expect(cookies).toContain("accessToken=");
  return { id: user.id, email, cookie: cookies } satisfies Account;
}

async function openStream(account: Account): Promise<Stream> {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/events/v1/stream`, {
    headers: { Cookie: account.cookie },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const events: StreamEvent[] = [];
  let markConnected!: () => void;
  const connected = new Promise<void>((resolve) => { markConnected = resolve; });
  const readLoop = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        while (buffer.includes("\n\n")) {
          const boundary = buffer.indexOf("\n\n");
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const type = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (type === "connected") markConnected();
          if (type && data && type !== "connected") {
            const event = JSON.parse(data) as { entityId: string };
            events.push({ type, entityId: event.entityId, receivedAt: performance.now() });
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  const stream = { events, close: async () => { abort.abort(); await readLoop; } };
  streams.push(stream);
  await Promise.race([
    connected,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("SSE connection handshake timed out")), 5_000)),
  ]);
  return stream;
}

async function waitForEvent(stream: Stream, incidentId: string, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const event = stream.events.find((item) => item.type === "incident.created" && item.entityId === incidentId);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Expected incident.created event did not reach an authorized stream");
}

function reportBody(
  account: Account,
  title: string,
  typeId: string,
  category: string,
  services?: string[],
  pin: { latitude: number; longitude: number } = { latitude: 10.262, longitude: 123.958 },
) {
  const publicId = `emergency-incidents/${account.id}/test-${randomUUID()}`;
  publicIds.push(publicId);
  return {
    title,
    description: "Disposable integration-test report, not a real emergency",
    typeId,
    category,
    barangayId,
    latitude: pin.latitude,
    longitude: pin.longitude,
    reporterPhone: "0000000000",
    ...(services && { requestedServices: services }),
    proofAttachment: { publicId, fileName: "test-evidence.jpg" },
  };
}

suite("disposable PostgreSQL incident delivery", () => {
  beforeAll(async () => {
    checkDisposableTarget();
    if (resolveBarangayFromCoordinates("Gabi", 10.262, 123.958) !== "Gabi") {
      throw new Error("Test pin is no longer accepted by the Gabi boundary data");
    }
    await prisma.$queryRaw`SELECT 1`;
    let barangay = await prisma.barangay.findUnique({ where: { name: "Gabi" } });
    if (!barangay) {
      barangay = await prisma.barangay.create({ data: { name: "Gabi", status: "ACTIVE" } });
      createdBarangayId = barangay.barangayId;
    }
    if (barangay.status !== "ACTIVE") throw new Error("Gabi barangay is inactive in the disposable database");
    barangayId = barangay.barangayId;
    const general = await prisma.incidentType.create({ data: { typeName: `Codex General ${testId}` } });
    const fireType = await prisma.incidentType.create({ data: { typeName: `Codex Fire ${testId}` } });
    generalTypeId = general.typeId;
    fireTypeId = fireType.typeId;
    typeIds.push(generalTypeId, fireTypeId);
    singleTypes.FIRE = fireTypeId;
    for (const service of ["MEDICAL", "POLICE", "HAZARD"] as const) {
      const type = await prisma.incidentType.create({ data: { typeName: `Codex ${service} ${testId}` } });
      singleTypes[service] = type.typeId;
      typeIds.push(type.typeId);
    }
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP server did not bind to a local port");
    base = `http://127.0.0.1:${address.port}`;
    [citizen, raceCitizenA, raceCitizenB, main, medical, hazard, fire, police] = await Promise.all([
      createAccount("USER"), createAccount("USER"), createAccount("USER"),
      createAccount("ADMIN", "MAIN"), createAccount("ADMIN", "MEDICAL"),
      createAccount("ADMIN", "DRRMO"), createAccount("ADMIN", "FIRE"),
      createAccount("ADMIN", "POLICE"),
    ]);
    singleCitizens = await Promise.all([0, 1, 2, 3].map(() => createAccount("USER")));
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled(streams.map((stream) => stream.close()));
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // Only exact IDs created by this suite are removed. A failed test can
    // still leave disposable fixtures for diagnosis if cleanup itself fails.
    if (userIds.length) {
      const persisted = await prisma.incident.findMany({
        where: { reportedBy: { in: userIds }, title: { contains: testId } },
        select: { incidentId: true, locationId: true },
      });
      incidentIds.push(...persisted.map((item) => item.incidentId));
      locationIds.push(...persisted.map((item) => item.locationId));
    }
    const uniqueIncidentIds = [...new Set(incidentIds)];
    if (uniqueIncidentIds.length) {
      for (const incidentId of uniqueIncidentIds) {
        await prisma.notificationOutbox.deleteMany({
          where: { payload: { path: ["data", "incidentId"], equals: incidentId } },
        });
      }
      await prisma.attachment.deleteMany({ where: { incidentId: { in: uniqueIncidentIds } } });
      await prisma.incident.deleteMany({ where: { incidentId: { in: uniqueIncidentIds } } });
    }
    if (userIds.length) await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    if (locationIds.length) await prisma.location.deleteMany({ where: { locationId: { in: [...new Set(locationIds)] } } });
    if (publicIds.length) await prisma.assetCleanupJob.deleteMany({ where: { publicId: { in: publicIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (typeIds.length) await prisma.incidentType.deleteMany({ where: { typeId: { in: typeIds } } });
    if (createdBarangayId) await prisma.barangay.delete({ where: { barangayId: createdBarangayId } });
    await prisma.$disconnect();
  }, 60_000);

  it("delivers a Medical+Hazard citizen report only to those departments and main admin", async () => {
    const recipients = await Promise.all([main, medical, hazard, fire, police].map(openStream));
    const title = `Codex multi-service ${testId}`;
    const startedAt = performance.now();
    const { response, body } = await jsonRequest("/api/incidents/v1/", {
      method: "POST",
      cookie: citizen.cookie,
      body: reportBody(citizen, title, generalTypeId, "other", ["MEDICAL", "HAZARD"]),
    });
    const submittedAt = performance.now();
    expect(response.status).toBe(201);
    const incidentId = body.data.incident.incidentId as string;
    incidentIds.push(incidentId);
    locationIds.push(body.data.incident.locationId as string);

    const positiveEvents = await Promise.all(recipients.slice(0, 3).map((stream) => waitForEvent(stream, incidentId)));
    console.info("Staging delivery sample (ms from POST start):", {
      submit: Math.round(submittedAt - startedAt),
      main: Math.round(positiveEvents[0].receivedAt - startedAt),
      medical: Math.round(positiveEvents[1].receivedAt - startedAt),
      hazard: Math.round(positiveEvents[2].receivedAt - startedAt),
    });
    for (const account of [main, medical, hazard]) {
      const result = await jsonRequest(`/api/incidents/v1/${incidentId}`, { cookie: account.cookie });
      expect(result.response.status).toBe(200);
      const list = await jsonRequest(`/api/incidents/v1/?reportedBy=${citizen.id}&includeTotal=false`, { cookie: account.cookie });
      expect(list.response.status).toBe(200);
      expect(list.body.data.incidents.some((item: { incidentId: string }) => item.incidentId === incidentId)).toBe(true);
    }
    for (const account of [fire, police]) {
      const result = await jsonRequest(`/api/incidents/v1/${incidentId}`, { cookie: account.cookie });
      expect(result.response.status).toBe(403);
      const list = await jsonRequest(`/api/incidents/v1/?reportedBy=${citizen.id}&includeTotal=false`, { cookie: account.cookie });
      expect(list.response.status).toBe(200);
      expect(list.body.data.incidents.some((item: { incidentId: string }) => item.incidentId === incidentId)).toBe(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(recipients[3].events.some((event) => event.entityId === incidentId)).toBe(false);
    expect(recipients[4].events.some((event) => event.entityId === incidentId)).toBe(false);
    await Promise.all(recipients.map((stream) => stream.close()));
    expect(positiveEvents.every((event) => event.receivedAt - startedAt < 5_000)).toBe(true);
  }, 30_000);

  it("routes each single-service report only to its matching department", async () => {
    const accounts = { FIRE: fire, MEDICAL: medical, POLICE: police, HAZARD: hazard };
    const services = ["FIRE", "MEDICAL", "POLICE", "HAZARD"] as const;
    const pins = [
      { latitude: 10.264, longitude: 123.960 },
      { latitude: 10.266, longitude: 123.962 },
      { latitude: 10.263, longitude: 123.965 },
      { latitude: 10.260, longitude: 123.960 },
    ];
    const streamsByService = Object.fromEntries(await Promise.all(services.map(async (service) =>
      [service, await openStream(accounts[service])] as const))) as Record<typeof services[number], Stream>;
    const mainStream = await openStream(main);
    const deliveryLatencies: number[] = [];
    for (const [index, service] of services.entries()) {
      const reporter = singleCitizens[index];
      const startedAt = performance.now();
      const { response, body } = await jsonRequest("/api/incidents/v1/", {
        method: "POST",
        cookie: reporter.cookie,
        body: reportBody(reporter, `Codex ${service} only ${testId}`, singleTypes[service]!, service.toLowerCase(), undefined, pins[index]),
      });
      const submittedAt = performance.now();
      expect(response.status).toBe(201);
      const id = body.data.incident.incidentId as string;
      incidentIds.push(id);
      locationIds.push(body.data.incident.locationId as string);
      const [selectedEvent, mainEvent] = await Promise.all([
        waitForEvent(streamsByService[service], id),
        waitForEvent(mainStream, id),
      ]);
      console.info("Staging single-service sample (ms from POST start):", {
        service,
        submit: Math.round(submittedAt - startedAt),
        selected: Math.round(selectedEvent.receivedAt - startedAt),
        main: Math.round(mainEvent.receivedAt - startedAt),
      });
      deliveryLatencies.push(selectedEvent.receivedAt - startedAt, mainEvent.receivedAt - startedAt);
      const selectedList = await jsonRequest(`/api/incidents/v1/?reportedBy=${reporter.id}&includeTotal=false`, { cookie: accounts[service].cookie });
      expect(selectedList.response.status).toBe(200);
      expect(selectedList.body.data.incidents.some((item: { incidentId: string }) => item.incidentId === id)).toBe(true);
      for (const other of services.filter((candidate) => candidate !== service)) {
        const denied = await jsonRequest(`/api/incidents/v1/${id}`, { cookie: accounts[other].cookie });
        expect(denied.response.status).toBe(403);
        const unrelatedList = await jsonRequest(`/api/incidents/v1/?reportedBy=${reporter.id}&includeTotal=false`, { cookie: accounts[other].cookie });
        expect(unrelatedList.response.status).toBe(200);
        expect(unrelatedList.body.data.incidents.some((item: { incidentId: string }) => item.incidentId === id)).toBe(false);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const other of services.filter((candidate) => candidate !== service)) {
        expect(streamsByService[other].events.some((event) => event.entityId === id)).toBe(false);
      }
    }
    await Promise.all([...Object.values(streamsByService), mainStream].map((stream) => stream.close()));
    expect(Math.max(...deliveryLatencies)).toBeLessThan(5_000);
  }, 60_000);

  it("accepts one of two simultaneous nearby Fire submissions and rejects the duplicate", async () => {
    const title = `Codex race ${testId}`;
    const startedAt = performance.now();
    const results = await Promise.all([raceCitizenA, raceCitizenB].map((account) =>
      jsonRequest("/api/incidents/v1/", {
        method: "POST",
        cookie: account.cookie,
        body: reportBody(account, title, fireTypeId, "fire"),
      })));
    expect(results.map(({ response }) => response.status).sort()).toEqual([201, 409]);
    const created = results.find(({ response }) => response.status === 201)!;
    const rejected = results.find(({ response }) => response.status === 409)!;
    expect(rejected.body.errorCode).toBe("DUPLICATE_ACTIVE_INCIDENT");
    expect(rejected.body).not.toHaveProperty("data.incident");
    incidentIds.push(created.body.data.incident.incidentId as string);
    locationIds.push(created.body.data.incident.locationId as string);
    const persisted = await prisma.incident.findMany({
      where: { title, reportedBy: { in: [raceCitizenA.id, raceCitizenB.id] } },
      select: { incidentId: true, attachments: { select: { attachmentId: true } }, serviceResponses: { select: { service: true } } },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].attachments).toHaveLength(1);
    expect(persisted[0].serviceResponses.map((item) => item.service)).toEqual(["FIRE"]);
    console.info("Disposable duplicate-race sample (ms):", Math.round(performance.now() - startedAt));
  }, 30_000);

  it("reviews a shared report without interrupting responses and permits deletion only by main admin after closure", async () => {
    const location = await prisma.location.create({ data: { locationName: `Codex review ${testId}` } });
    locationIds.push(location.locationId);
    const publicId = `emergency-incidents/${citizen.id}/test-review-${testId}`;
    publicIds.push(publicId);
    const incident = await prisma.incident.create({ data: {
      title: `Codex review ${testId}`, typeId: generalTypeId, locationId: location.locationId,
      reportedBy: citizen.id, severityLevel: "LOW", status: "RESPONDING", requestedServices: ["FIRE", "MEDICAL"],
      serviceResponses: { create: [{ service: "FIRE" }, { service: "MEDICAL" }] },
      attachments: { create: { fileName: "synthetic-review.jpg", fileType: "image/jpeg", fileUrl: "https://evidence.invalid/review", publicId, uploadedBy: citizen.id } },
    } });
    incidentIds.push(incident.incidentId);
    const path = `/api/incidents/v1/${incident.incidentId}`;
    const flagBody = { reason: "Synthetic report confirmed as a training exercise" };
    for (const account of [citizen, police]) {
      expect((await jsonRequest(`${path}/review-flags`, { method: "POST", cookie: account.cookie, body: flagBody })).response.status).toBe(403);
    }
    const repeated = await Promise.all([1, 2].map(() => jsonRequest(`${path}/review-flags`, { method: "POST", cookie: fire.cookie, body: flagBody })));
    expect(repeated.map(result => result.response.status)).toEqual([200, 200]);
    const flag = repeated[0].body.data.flag;
    expect(repeated[1].body.data.flag.reviewFlagId).toBe(flag.reviewFlagId);
    expect(await prisma.incidentReviewFlag.count({ where: { incidentId: incident.incidentId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: incident.incidentId, action: "INCIDENT_FLAGGED" } })).toBe(1);
    const citizenRead = await jsonRequest(path, { cookie: citizen.cookie });
    expect(citizenRead.body.data.incident.reviewFlags).toBeUndefined();
    const medicalRead = await jsonRequest(path, { cookie: medical.cookie });
    expect(medicalRead.body.data.incident.reviewFlags).toEqual([]);
    expect(medicalRead.body.data.incident.status).toBe("RESPONDING");
    expect((await jsonRequest("/api/incidents/v1/review-flags", { cookie: fire.cookie })).response.status).toBe(403);
    const queue = await jsonRequest("/api/incidents/v1/review-flags", { cookie: main.cookie });
    expect(queue.response.status).toBe(200);
    expect(queue.body.data.flags.some((item: { reviewFlagId: string }) => item.reviewFlagId === flag.reviewFlagId)).toBe(true);
    const decision = { status: "CONFIRMED", reviewNotes: "Confirmed by the synthetic test operator", expectedUpdatedAt: flag.updatedAt };
    expect((await jsonRequest(`${path}/review-flags/${flag.reviewFlagId}`, { method: "PATCH", cookie: fire.cookie, body: decision })).response.status).toBe(403);
    const decisions = await Promise.all([1, 2].map(() => jsonRequest(`${path}/review-flags/${flag.reviewFlagId}`, { method: "PATCH", cookie: main.cookie, body: decision })));
    expect(decisions.map(result => result.response.status).sort()).toEqual([200, 409]);
    const unchanged = await prisma.incident.findUniqueOrThrow({ where: { incidentId: incident.incidentId }, include: { attachments: true, serviceResponses: true } });
    expect(unchanged.status).toBe("RESPONDING");
    expect(unchanged.attachments).toHaveLength(1);
    expect(unchanged.serviceResponses.every(service => service.status === "RESPONDING")).toBe(true);
    const deletion = { reason: "Synthetic confirmed false report cleanup", confirmation: "DELETE" };
    expect((await jsonRequest(path, { method: "DELETE", cookie: fire.cookie, body: deletion })).response.status).toBe(403);
    expect((await jsonRequest(path, { method: "DELETE", cookie: main.cookie, body: deletion })).response.status).toBe(409);
    for (const status of ["RESOLVED", "CLOSED"]) expect((await jsonRequest(path, { method: "PUT", cookie: main.cookie, body: { status } })).response.status).toBe(200);
    expect((await jsonRequest(path, { method: "DELETE", cookie: main.cookie, body: { ...deletion, confirmation: "delete" } })).response.status).toBe(400);
    expect((await jsonRequest(path, { method: "DELETE", cookie: main.cookie, body: deletion })).response.status).toBe(200);
    expect(await prisma.incident.count({ where: { incidentId: incident.incidentId } })).toBe(0);
    expect(await prisma.incidentReviewFlag.count({ where: { incidentId: incident.incidentId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: incident.incidentId, action: "INCIDENT_DELETED" } })).toBe(1);
    expect(await prisma.assetCleanupJob.count({ where: { publicId } })).toBe(1);
  }, 120_000);
});
