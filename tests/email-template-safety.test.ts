import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/utils/template";

describe("verification email template", () => {
  it("escapes user-supplied markup and replacement metacharacters", () => {
    const html = renderTemplate("verify-email.html", {
      name: '<img src=x onerror="alert(1)">$&',
      emailVerificationURL: "https://example.test/verify?first=1&second=2",
      expiresAt: "tomorrow",
    });
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;$&amp;");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("first=1&amp;second=2");
  });
});
