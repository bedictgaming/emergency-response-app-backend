import { expect, it, vi } from "vitest";
const create = vi.hoisted(() => vi.fn(async () => ({ userId: "new-citizen" })));
vi.mock("@/lib/prisma", () => ({ prisma: { oAuthAccount: { create } } }));
import { OAuthAccountRepository } from "@/repositories/oauth-account.repository";
it("creates the user and Google link together without role or existing-user inputs", async () => {
  await new OAuthAccountRepository().createUserWithAccount({ providerAccountId: "google-id", name: "Citizen", email: "citizen@gmail.com" });
  expect(create).toHaveBeenCalledWith({ data: { provider: "google", providerAccountId: "google-id",
    user: { create: { name: "Citizen", email: "citizen@gmail.com", emailVerified: expect.any(Date) } } }, select: { userId: true } });
});
