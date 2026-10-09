import { expect, it, vi } from 'vitest';
import { VerifyEmailService } from '@/services/auth/verify-email-service';
import { ResendEmailVerificationService } from '@/services/auth/resend-email-verification-service';

const calls = vi.hoisted(() => ({ database: vi.fn(), mail: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $queryRaw: calls.database } }));
vi.mock('@/services/mail/mailer', () => ({ sendEmail: calls.mail }));
it('historical verification imports fail closed without mutating records or sending mail', async () => {
  for (const token of ['', 'invalid', '11111111-1111-4111-8111-111111111111']) {
    expect(await VerifyEmailService(token)).toMatchObject({ code: 410, status: 'error' });
  }
  expect(await ResendEmailVerificationService('synthetic@example.test')).toMatchObject({ code: 410, status: 'error' });
  expect(calls.database).not.toHaveBeenCalled(); expect(calls.mail).not.toHaveBeenCalled();
});
