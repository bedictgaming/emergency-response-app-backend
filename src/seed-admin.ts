import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/utils/password";
import { Department, Role } from "@/generated/prisma";
import { randomUUID } from "node:crypto";

/** One-time bootstrap, never a recurring credential reset. */
async function bootstrapMainAdministrator() {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const name = process.env.ADMIN_BOOTSTRAP_NAME?.trim() || "Main System Administrator";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 16) {
    throw new Error("Set ADMIN_BOOTSTRAP_EMAIL and a unique ADMIN_BOOTSTRAP_PASSWORD of at least 16 characters");
  }
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('main-admin-bootstrap'))::text AS lock_token`;
    const existingMain = await tx.user.count({
      where: { role: Role.ADMIN, department: Department.MAIN, isMainAdmin: true },
    });
    if (existingMain > 0 || await tx.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new Error("Administrator bootstrap refused: an account already exists; use the authorized account-management workflow");
    }
    const id = randomUUID();
    await tx.user.create({
      data: {
        id,
        name,
        email,
        password: await hashPassword(password),
        role: Role.ADMIN,
        department: Department.MAIN,
        isMainAdmin: true,
        emailVerified: new Date(),
        authIdentities: { create: { provider: "password", providerUserId: id, email } },
      },
    });
  });
  console.log("Main administrator bootstrap completed");
}

bootstrapMainAdministrator()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
