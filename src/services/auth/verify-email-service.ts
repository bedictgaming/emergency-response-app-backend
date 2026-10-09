// Historical import compatibility only: no account/token/session mutations.
export async function VerifyEmailService(_token: string) {
  return { code: 410, status: "error", message: "Email verification is no longer available." };
}
