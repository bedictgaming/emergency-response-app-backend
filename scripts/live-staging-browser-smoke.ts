/**
 * One-off protected Vercel -> Railway -> disposable PostgreSQL browser check.
 * Requires the exact staging database and a short-lived Vercel bypass cookie.
 * Never run against the hosted application database.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/prisma";
import { hashPassword } from "../src/utils/password";

const frontendRequire = createRequire(fileURLToPath(new URL("../../emergency-response-app-frontend/package.json", import.meta.url)));
const { chromium } = frontendRequire("@playwright/test");
const sharp = frontendRequire("sharp");
const origin = "https://cordova-emergency-response.vercel.app";
const apiOrigin = "https://api-staging-staging-86d9.up.railway.app";
const databaseName = "emergency_staging_20260927_c6b212";

function assertStagingTarget() {
  const pool = new URL(process.env.DATABASE_URL || "");
  const direct = new URL(process.env.DIRECT_URL || "");
  if (decodeURIComponent(pool.pathname.slice(1)) !== databaseName
    || decodeURIComponent(direct.pathname.slice(1)) !== databaseName
    || process.env.CONFIRM_DISPOSABLE_DATABASE !== databaseName
    || !pool.hostname.includes("neon.tech") || !direct.hostname.includes("neon.tech")
    || !process.env.STAGING_VERCEL_COOKIE) {
    throw new Error("Exact disposable database and protected-preview cookie are required");
  }
}

async function run() {
  assertStagingTarget();
  const marker = `STAGING TEST ${randomUUID().slice(0, 8)}`;
  const password = `Codex-Staging-${randomUUID()}!`;
  const users: { id: string; email: string; role: string; department?: string }[] = [];
  const uploadedIds = new Set<string>();
  const apiErrors: string[] = [];
  let testBarangayId: string | undefined;
  let browser: any;
  let outcome: Error | undefined;
  try {
    const existingUsers = await prisma.user.count();
    const existingIncidents = await prisma.incident.count();
    if (existingUsers || existingIncidents) throw new Error("Staging database is not empty; refusing fixture creation");
    const barangay = await prisma.barangay.create({ data: { name: "Gabi", status: "ACTIVE" } });
    testBarangayId = barangay.barangayId;
    for (const [role, department] of [
      ["USER", undefined], ["ADMIN", "MEDICAL"], ["ADMIN", "DRRMO"],
      ["ADMIN", "FIRE"], ["ADMIN", "POLICE"],
    ] as const) {
      const email = `codex-${marker.replaceAll(" ", "-").toLowerCase()}-${department || "citizen"}@example.invalid`;
      const account = await prisma.user.create({
        data: { email, name: `Disposable ${marker}`, password: hashPassword(password), emailVerified: new Date(), role, department },
        select: { id: true },
      });
      users.push({ id: account.id, email, role, department });
    }

    browser = await chromium.launch({ headless: true });
    const contexts = new Map<string, any>();
    const pages = new Map<string, any>();
    for (const account of users) {
      const key = account.department || "citizen";
      const context = await browser.newContext({
        serviceWorkers: "block",
        ...(key === "citizen" && { geolocation: { latitude: 10.262, longitude: 123.958 }, permissions: ["geolocation"] }),
      });
      await context.addCookies([{ name: "_vercel_jwt", value: process.env.STAGING_VERCEL_COOKIE!, url: origin }]);
      const page = await context.newPage();
      page.on("response", (response: any) => {
        const url = new URL(response.url());
        if (url.origin === apiOrigin && response.status() >= 500) apiErrors.push(`${url.pathname}: ${response.status()}`);
        if (url.hostname === "api.cloudinary.com" && url.pathname.endsWith("/image/upload") && response.ok()) {
          void response.json().then((body: { public_id?: string }) => {
            if (body.public_id?.startsWith(`emergency-incidents/${users[0].id}/`)) uploadedIds.add(body.public_id);
          }).catch(() => {});
        }
      });
      await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.getByLabel("Email").first().fill(account.email);
      await page.getByLabel("Password", { exact: true }).first().fill(password);
      await page.getByRole("button", { name: "Login", exact: true }).click();
      await page.waitForURL(key === "citizen" ? /\/dashboard$/ : new RegExp(`/admin/${key === "DRRMO" ? "drrmo" : key.toLowerCase()}-dashboard$`), { timeout: 45_000 });
      contexts.set(key, context);
      pages.set(key, page);
      console.log(`${key} browser login: passed`);
    }

    const citizen = pages.get("citizen");
    await citizen.getByText("Choose emergency type").waitFor({ timeout: 30_000 });
    await citizen.getByRole("button", { name: "Report an emergency that needs other or multiple services" }).click();
    const dialog = citizen.getByRole("dialog", { name: "Report Emergency" });
    await dialog.getByLabel("Medical / EMS response").check();
    await dialog.getByLabel("Hazard / DRRMO response").check();
    await dialog.getByLabel("Description of Incident").fill(`${marker}: synthetic browser-delivery check, not an emergency`);
    await dialog.getByLabel("Contact Number").fill("09170000000");
    await dialog.locator(".leaflet-container").waitFor({ state: "visible", timeout: 30_000 });
    await dialog.getByRole("button", { name: "Confirm center" }).click();
    await dialog.getByText("Location confirmed", { exact: true }).waitFor({ timeout: 10_000 });
    await dialog.getByLabel("Incident barangay").selectOption("Gabi");
    await dialog.getByLabel("Exact Location").fill(`${marker} location, Gabi, Cordova`);
    const svg = Buffer.from(`<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg"><rect width="256" height="256" fill="#e8e8e8"/><text x="25" y="100" font-size="32" fill="#222">STAGING</text><text x="70" y="145" font-size="32" fill="#222">TEST</text></svg>`);
    const png = await sharp(svg).png().toBuffer();
    await dialog.locator('input[type="file"]').setInputFiles({ name: "staging-test.png", mimeType: "image/png", buffer: png });
    const incidentResponse = citizen.waitForResponse((response: any) => response.url().startsWith(`${apiOrigin}/api/incidents/v1/`) && response.request().method() === "POST" && !response.url().includes("nearby-check"), { timeout: 90_000 });
    await dialog.getByRole("button", { name: "Submit Report", exact: true }).click();
    const created = await incidentResponse;
    if (created.status() !== 201) {
      const body = await created.json().catch(() => ({}));
      throw new Error(`Browser incident submission returned ${created.status()}: ${String(body.message || "unknown error")}`);
    }
    const responseBody = await created.json();
    const incidentId = responseBody?.data?.incident?.incidentId;
    if (!incidentId) throw new Error("Created response omitted incident ID");
    console.log("Citizen browser photo upload and incident submission: passed");

    const positive = ["MEDICAL", "DRRMO"];
    for (const key of positive) {
      await pages.get(key).getByText(marker, { exact: false }).first().waitFor({ timeout: 20_000 });
      console.log(`${key} live dashboard delivery: passed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    for (const key of ["FIRE", "POLICE"]) {
      const page = pages.get(key);
      if (await page.getByText(marker, { exact: false }).count()) throw new Error(`${key} dashboard displayed an unrelated report`);
      const list = await page.request.get(`${apiOrigin}/api/incidents/v1/?limit=10`);
      if (list.status() !== 200 || JSON.stringify(await list.json()).includes(incidentId)) throw new Error(`${key} incident list leaked the unrelated report`);
      const detail = await page.request.get(`${apiOrigin}/api/incidents/v1/${incidentId}`);
      if (![403, 404].includes(detail.status())) throw new Error(`${key} incident detail returned ${detail.status()}`);
      console.log(`${key} dashboard/list/detail isolation: passed`);
    }
    const persisted = await prisma.incident.findUnique({
      where: { incidentId },
      select: { status: true, verificationStatus: true, reportedBy: true, serviceResponses: { select: { service: true } }, attachments: { select: { publicId: true } } },
    });
    if (!persisted || persisted.reportedBy !== users[0].id || persisted.status !== "RESPONDING"
      || persisted.verificationStatus !== "VERIFIED"
      || persisted.serviceResponses.map((row) => row.service).sort().join(",") !== "HAZARD,MEDICAL"
      || persisted.attachments.length !== 1) throw new Error("Persisted incident scope, status, or evidence is incorrect");
    if (persisted.attachments[0].publicId) uploadedIds.add(persisted.attachments[0].publicId);
    if (apiErrors.length) throw new Error(`Staging API returned server errors: ${apiErrors.join(", ")}`);
    console.log("Persisted service/evidence scope and API error check: passed");
  } catch (error) {
    outcome = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (browser) await browser.close();
    const userIds = users.map((user) => user.id);
    if (userIds.length) {
      const incidents = await prisma.incident.findMany({
        where: { reportedBy: { in: userIds } },
        select: { incidentId: true, locationId: true, attachments: { select: { publicId: true } } },
      });
      const incidentIds = incidents.map((incident) => incident.incidentId);
      const locationIds = incidents.map((incident) => incident.locationId);
      for (const incident of incidents) for (const attachment of incident.attachments) if (attachment.publicId) uploadedIds.add(attachment.publicId);
      for (const incidentId of incidentIds) {
        await prisma.notificationOutbox.deleteMany({ where: { payload: { path: ["data", "incidentId"], equals: incidentId } } });
      }
      await prisma.attachment.deleteMany({ where: { incidentId: { in: incidentIds } } });
      await prisma.incident.deleteMany({ where: { incidentId: { in: incidentIds } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
      await prisma.location.deleteMany({ where: { locationId: { in: locationIds } } });
      await prisma.assetCleanupJob.deleteMany({ where: { publicId: { in: [...uploadedIds] } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      console.log(`Synthetic staging database cleanup: ${userIds.length} accounts, ${incidents.length} incidents`);
    }
    if (testBarangayId) await prisma.barangay.delete({ where: { barangayId: testBarangayId } });
    if (uploadedIds.size) {
      const { v2: cloudinary } = await import("cloudinary");
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });
      for (const publicId of uploadedIds) {
        if (!publicId.startsWith(`emergency-incidents/${users[0]?.id}/`)) continue;
        const result = await cloudinary.uploader.destroy(publicId, { type: "authenticated", invalidate: true });
        if (!["ok", "not found"].includes(result.result)) throw new Error("Synthetic Cloudinary asset cleanup failed");
      }
      console.log(`Synthetic Cloudinary asset cleanup: ${uploadedIds.size} assets`);
    }
    await prisma.$disconnect();
  }
  if (outcome) throw outcome;
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
