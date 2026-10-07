// Retired, deliberately not exported by the auth service barrel or routed.
// A legacy internal caller must not look up an account, claim a token or send.
export async function ResendEmailVerificationService(_email: string) {
  return { code: 410, status: "error", message: "Verification email resend is no longer available." };
}
