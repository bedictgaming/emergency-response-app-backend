import { expect, it, vi } from "vitest";
const google = vi.hoisted(() => vi.fn());
vi.mock("@/services/auth", () => ({ GoogleOAuthService: google }));
import { AuthController } from "@/controllers/auth.controller";
it.each(["oauth_link_required", "oauth_link_password_required", "oauth_email_verification_required", "unknown-secret"])("redirects only safe OAuth error enum %s without credentials", async errorCode => {
  google.mockResolvedValue({ code: 403, errorCode, message: "private@example.test" });
  const response = { redirect: vi.fn(), cookie: vi.fn() };
  await new AuthController().googleCallback({ user: {} } as never, response as never);
  expect(response.redirect).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`/login\\?oauth=${errorCode === "unknown-secret" ? "oauth_failed" : errorCode}$`)));
  expect(response.cookie).not.toHaveBeenCalled(); expect(JSON.stringify(response.redirect.mock.calls)).not.toContain("private@example.test");
});
