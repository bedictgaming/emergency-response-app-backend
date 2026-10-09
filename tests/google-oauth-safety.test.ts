import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  findProvider: vi.fn(), createLinkedUser: vi.fn(), createLink: vi.fn(),
  findEmail: vi.fn(), findUser: vi.fn(), createUser: vi.fn(), verifyEmail: vi.fn(),
  createSession: vi.fn(), access: vi.fn(), refresh: vi.fn(),
}));
vi.mock("@/repositories/oauth-account.repository", () => ({ OAuthAccountRepository: class {
  findByProvider = mocks.findProvider; createUserWithAccount = mocks.createLinkedUser; create = mocks.createLink;
} }));
vi.mock("@/repositories/user.repository", () => ({ UserRepository: class {
  findByEmail = mocks.findEmail; findById = mocks.findUser; create = mocks.createUser; markEmailVerified = mocks.verifyEmail;
} }));
vi.mock("@/repositories/token.repository", () => ({ TokenRepository: class { createRefreshToken = mocks.createSession; } }));
vi.mock("@/lib/jwt", () => ({ signAccessToken: mocks.access, signRefreshToken: mocks.refresh,
  TokenExpiry: { REFRESH_TOKEN_EXPIRES: "7d", ACCESS_TOKEN_EXPIRES: "15m" },
}));
import { GoogleOAuthService } from "@/services/auth/google-oauth-service";

const profile = (overrides = {}) => ({ provider: "google", id: "google-subject", displayName: "Citizen",
  emails: [{ value: "citizen@gmail.com", verified: true }], _json: { email: "citizen@gmail.com", email_verified: true }, ...overrides,
} as never);
const user = { id: "citizen", name: "Citizen", email: "citizen@gmail.com", role: "USER", department: null, isMainAdmin: false, status: "ACTIVE" };
const noWrites = () => {
  expect(mocks.createLink).not.toHaveBeenCalled(); expect(mocks.createUser).not.toHaveBeenCalled();
  expect(mocks.createLinkedUser).not.toHaveBeenCalled(); expect(mocks.verifyEmail).not.toHaveBeenCalled();
  expect(mocks.createSession).not.toHaveBeenCalled(); expect(mocks.access).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
};
describe("Google identity boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findProvider.mockResolvedValue(null); mocks.findEmail.mockResolvedValue(null);
    mocks.createLinkedUser.mockResolvedValue({ userId: user.id }); mocks.findUser.mockResolvedValue(user);
    mocks.createSession.mockResolvedValue({ id: "session" }); mocks.access.mockReturnValue("access"); mocks.refresh.mockReturnValue("refresh");
  });
  it("never links or verifies an existing admin by matching email", async () => {
    mocks.findEmail.mockResolvedValue({ ...user, role: "ADMIN", emailVerified: null });
    expect(await GoogleOAuthService(profile())).toMatchObject({ code: 409, errorCode: "oauth_link_required" }); noWrites();
  });
  it.each([false, undefined, "true"])("rejects unverified email claim %s", async (verified) => {
    expect((await GoogleOAuthService(profile({ _json: { email: user.email, email_verified: verified } }))).code).toBe(403); noWrites();
  });
  it("rejects an unverified parsed email even if raw claims say verified", async () => {
    expect((await GoogleOAuthService(profile({ emails: [{ value: user.email, verified: false }] }))).code).toBe(403); noWrites();
  });
  it("rejects missing, conflicting and malformed email claims", async () => {
    for (const overrides of [{ emails: [] }, { emails: [{ value: "invalid", verified: true }] }, { _json: { email: "other@gmail.com", email_verified: true } }]) {
      expect((await GoogleOAuthService(profile(overrides))).code).toBe(403);
    } noWrites();
  });
  it("does not treat a verified third-party Google email as current ownership", async () => {
    expect(await GoogleOAuthService(profile({ emails: [{ value: "citizen@example.test", verified: true }],
      _json: { email: "citizen@example.test", email_verified: true } }))).toMatchObject({ code: 403, errorCode: "oauth_email_verification_required" }); noWrites();
  });
  it("atomically provisions a new verified Gmail user without privilege inputs", async () => {
    expect((await GoogleOAuthService(profile())).code).toBe(200);
    expect(mocks.createLinkedUser).toHaveBeenCalledWith({ providerAccountId: "google-subject", name: "Citizen", email: user.email });
    expect(mocks.createLink).not.toHaveBeenCalled(); expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.access).toHaveBeenCalledWith("citizen", "USER", "15m", "session");
  });
  it("accepts verified Workspace ownership with a matching hosted-domain claim", async () => {
    expect((await GoogleOAuthService(profile({ emails: [{ value: "citizen@example.test", verified: true }],
      _json: { email: "citizen@example.test", email_verified: true, hd: "example.test" } }))).code).toBe(200);
  });
  it("rejects a hosted-domain mismatch", async () => {
    expect((await GoogleOAuthService(profile({ emails: [{ value: "citizen@example.test", verified: true }],
      _json: { email: "citizen@example.test", email_verified: true, hd: "other.test" } }))).code).toBe(403); noWrites();
  });
  it("uses an existing provider link even when the Google email changes", async () => {
    mocks.findProvider.mockResolvedValue({ userId: user.id });
    expect((await GoogleOAuthService(profile({ emails: [], _json: {} }))).code).toBe(200);
    expect(mocks.findEmail).not.toHaveBeenCalled(); expect(mocks.verifyEmail).not.toHaveBeenCalled();
    expect(mocks.createLinkedUser).not.toHaveBeenCalled();
  });
  it("preserves an already-linked active admin's current RBAC assignment", async () => {
    mocks.findProvider.mockResolvedValue({ userId: user.id });
    mocks.findUser.mockResolvedValue({ ...user, role: "ADMIN", department: "MAIN", isMainAdmin: true });
    const result = await GoogleOAuthService(profile());
    expect(result.code).toBe(200); expect(result.data?.user.permissions).toContain("incident:manage-all");
    expect(mocks.access).toHaveBeenCalledWith(user.id, "ADMIN", "15m", "session");
    expect(mocks.findEmail).not.toHaveBeenCalled(); expect(mocks.verifyEmail).not.toHaveBeenCalled();
  });
  it("denies inactive linked accounts without issuing a session", async () => {
    mocks.findProvider.mockResolvedValue({ userId: user.id }); mocks.findUser.mockResolvedValue({ ...user, status: "INACTIVE" });
    expect((await GoogleOAuthService(profile())).code).toBe(403); noWrites();
  });
  it("denies a retired responder even with an existing Google binding", async () => {
    mocks.findProvider.mockResolvedValue({ userId: user.id });
    mocks.findUser.mockResolvedValue({ ...user, role: "RESPONDER", department: "FIRE" });
    expect((await GoogleOAuthService(profile())).code).toBe(403);
    noWrites();
  });
  it("denies linked operational accounts without an assignment", async () => {
    mocks.findProvider.mockResolvedValue({ userId: user.id }); mocks.findUser.mockResolvedValue({ ...user, role: "ADMIN" });
    expect((await GoogleOAuthService(profile())).code).toBe(403); noWrites();
  });
  it("rejects missing or foreign provider identities before database access", async () => {
    for (const value of [profile({ id: "" }), profile({ provider: "other" }), undefined]) expect((await GoogleOAuthService(value as never)).code).toBe(400);
    expect(mocks.findProvider).not.toHaveBeenCalled(); noWrites();
  });
  it("fails closed on concurrent unique collisions without an email-link fallback", async () => {
    mocks.createLinkedUser.mockRejectedValue({ code: "P2002" });
    expect((await GoogleOAuthService(profile())).code).toBe(409);
    expect(mocks.findEmail).toHaveBeenCalledOnce(); expect(mocks.createLink).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled(); expect(mocks.verifyEmail).not.toHaveBeenCalled();
  });
});
