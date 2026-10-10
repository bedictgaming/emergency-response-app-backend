# Optional Google identities — release candidate

Baseline backend: `29b101e9170eeadfefd2652cd36decaae2220298`.
Paired frontend baseline: `d1ee16613c64288921e57e80ac25fe4cc577090d`.
Branch: `implementation/auth-identities-20261010`.

This candidate introduces `auth_identities`, preserving User IDs and existing stable Google subjects. Password identity subjects are User IDs, never hashes. The historical GoogleLinkIntent migration is byte-equivalent to its previously applied staging version. A new transactional migration normalizes emails and adds a normalized unique email index. It aborts on collisions or incompatible legacy bindings; no accounts are automatically merged or deleted. OAuthAccount remains historical evidence, not a runtime fallback.

Established Google subjects resolve their existing user. Automatic email linking requires an ACTIVE locally verified citizen and strict Google-authoritative verified matching Gmail/Workspace email. Unverified local password citizens and all operational accounts must log in with password and explicitly connect Google in Settings. This prevents pre-hijacking and does not restore mandatory citizen verification. Roles, departments, local verification, authorization and incident/evidence workflows are unchanged.

Owned login-methods and password-confirmed link/unlink routes share the existing persistent cookie/session model. Five-minute single-use intents bind state, password snapshot, current account/email/session and S256 challenge; the verifier is HttpOnly. Claim precedes code exchange; callbacks cannot fall through to ordinary login. User/Token locks recheck current state. Link/unlink audit and revoke other sessions, never the current password session or the last login method. Sign-in rereads Google binding under the User lock before issuing a bound session.

Local build/runtime imports and 603 tests pass; 41 opt-in database tests skip without an approved disposable target. The native CI runner applies real SQL to an empty loopback PostgreSQL database only, authenticates synthetic encrypted snapshots before DDL, checks three transactional abort guards and successful legacy backfill, and runs fifteen new identity transaction/race cases alongside the existing alert gate. Provider fetches are forbidden and fixtures are removed precisely. These native checks are pending hosted execution at preparation time. The initial local invocation without a placeholder database URL failed imports and is retained as a failed attempt, not a pass.

Release gates: exact-source completed CI; authenticated encrypted backup of each exact live target before migrations; actual migration-history/conflict review; real native/staging migration/concurrency checks; coordinated quiescence of legacy auth writers and post-backfill identity-drift check; paired frontend/backend staging acceptance; actual Google/PKCE/link/unlink/relogin/persistent-session checks on Safari/PWA and admin accounts. A build or mocked browser pass is not live-provider/device proof. No schema, deployment or provider/security setting is changed merely by this candidate commit.

Do not roll back to a legacy OAuthAccount-based backend after registry mutations: it can revive removed bindings. Recovery must be forward-compatible or use separately reviewed reconciliation under the same backup and authorization gates. Secrets, private records and incident/evidence changes are out of scope.

Canonical engineering reference and detailed local validation: workspace `MASTER_PROMPT.md` Section 60 and `ACCOUNT_IDENTITIES_2026-10-10.md`.
