// Brevo opens a real UI before the capability is redeemed by explicit action.
// Other transports and previously sent API links retain their existing contract.
export function verificationEmailUrl(token: string): string {
  if (process.env.MAIL_PROVIDER === 'brevo') {
    const configured = process.env.FRONTEND_URL;
    if (!configured) throw new Error('Verification frontend origin is not configured');
    const origin = new URL(configured);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
      throw new Error('Verification frontend requires a secure origin');
    }
    return `${origin.origin}/login?verificationToken=${encodeURIComponent(token)}`;
  }
  return `${process.env.BACKEND_URL}/api/auth/v1/verify-email?token=${encodeURIComponent(token)}`;
}
