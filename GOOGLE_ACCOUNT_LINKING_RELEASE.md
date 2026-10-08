# Citizen Google connection release — October 9, 2026

Citizen-only explicit linking requires the current system password, authenticated
current refresh session, one-use state, PKCE and the same Google-authoritative
email. Linking never merges users or verifies local email. Unlink requires a
working password and revokes all old sessions. Ordinary Google sign-in rechecks
its exact stable-provider binding under the User lock before minting a session.

Additive migration `20261009090000_google_account_linking` is operator-controlled,
never automatic at startup. `GOOGLE_ACCOUNT_LINKING_ENABLED` defaults false.
Authenticate a fresh encrypted backup before migration. Native CI provisions
only empty loopback PostgreSQL 18, authenticates encrypted synthetic snapshots
before DDL, then runs existing alert gates and new real-database Google-link
transaction, uniqueness, rollback, logout, reset, session-change and unlink/login
races. Provider exchange is tested separately with fake receipts; neither these
native tests nor browser mocks prove actual Google consent/callback behavior.

Release remains pending exact-source CI, controlled first-party staging Google
consent and logout/login/mismatch/cancel/replay/password-fallback/all-session
unlink acceptance, then compatible production rollout and actual-host checks.
Keep existing gateway, worker containment, Brevo, evidence and protection.
Rollback by disabling the flag, retaining schema and provider bindings.
