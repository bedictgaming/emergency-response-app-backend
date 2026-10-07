# Citizen access and recovery — October 7, 2026

This release restores password recovery while removing only the USER email-verification gate. Citizen signup creates an ACTIVE USER with an unverified email and no verification token or send. Login and refresh still require current active status, valid credentials/session and assignment checks; staff verification remains required. Resend verification is retired. Existing verification links remain optional compatibility actions, not login authority. Report verification and operational alert/evidence workflows are unchanged.

Recovery request returns the same generic 202 for ineligible accounts and provider/database failures. Confirm requires a 30-minute random capability stored only as a digest, rechecks and atomically claims after the user lock, changes only the password hash and revokes prior sessions. No new schema or migration.

Canonical workspace reference: MASTER_PROMPT.md Section 37. Clean candidate excludes unfinished VPS, Gmail API and separate relay work. Build/tests and CI do not establish email delivery.

Deployment preparation found Brevo rejecting the applied staging API key with HTTP 401. No send or cloud configuration write occurred. Production remains on its prior release and default SMTP; its mail delivery cannot be certified. A private replacement from the reactivated authorized account, controlled staging reset receipt/redemption/session acceptance, exact-candidate CI and supervised publication are required before activation.

The operator has now applied a private replacement. Read-only Brevo checks return 200 with transactional sending enabled and the intended sender active. Clean build/native runtime and all 530 provider-free tests pass, with 25 intentional integration skips. The missing-loopback test configuration in the first command was corrected without production credentials. Exact CI, staging publication and real reset receipt/redemption/session acceptance still require observation.
