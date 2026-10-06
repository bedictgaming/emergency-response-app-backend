export type MailFailure =
  | 'MAIL_CONFIGURATION' | 'MAIL_AUTH' | 'MAIL_SENDER' | 'MAIL_RATE_LIMIT'
  | 'MAIL_PROVIDER_REJECTED' | 'MAIL_NETWORK' | 'MAIL_TIMEOUT' | 'MAIL_RESPONSE';

// Never attach a provider error/cause: it may contain credentials or recipients.
export class MailDeliveryError extends Error {
  constructor(public readonly category: MailFailure) {
    super(category);
    this.name = 'MailDeliveryError';
  }
}

export function mailFailureCategory(error: unknown): MailFailure | 'ACCOUNT_EMAIL_UNAVAILABLE' {
  return error instanceof MailDeliveryError ? error.category : 'ACCOUNT_EMAIL_UNAVAILABLE';
}
