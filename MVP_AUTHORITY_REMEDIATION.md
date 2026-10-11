# MVP audit remediation — 12 October 2026

Base: the actually deployed backend `2967c9bdb42c62207712972fd99f2b419c461d77`, not remote main or the dirty primary checkout. Work branch: `fix/mvp-authority-20261012`. No schema, auth-token, route, provider, cleanup, worker or production configuration change.

Incident creation already locked the reporter row, but used role/department values read before the lock. It now rereads current status/role/department/Main assignment under that same lock before any location, incident, audit or notification-outbox write. Account administration uses the same row boundary, so a committed demotion, deactivation or department transfer cannot leave the report request using old privileges.

Missing/inactive/retired/invalid current assignments return 403. A valid assignment different from the preflight snapshot returns 409 with a refresh/retry explanation. Do not silently reinterpret a staff request as a citizen request or upgrade a citizen request to staff privileges: evidence, location, service scope and duplicate override were checked under the original assignment. Unchanged requests retain the existing workflow and proofs. A rejected, verified-but-unreferenced upload may still queue contained cleanup through the existing failure path; referenced evidence and provider bytes are not deleted here.

Tests:

- Existing incident-service fixtures supply an explicit locked ACTIVE account snapshot.
- `tests/incident-authority.test.ts` adds 12 provider-free positive/negative regressions, including no report/audit/outbox/event side effects on withdrawn or changed authority.
- `tests/incident-authority-database.integration.test.ts` adds three real two-connection races: role demotion, deactivation and department transfer. The account mutation holds a native user-row lock; the test observes the report waiting, commits the account change, and requires rejection with no report/audit/outbox writes.
- The existing native gate now includes these races along with alert and identity tests. It still accepts only an empty confirmed loopback `alert_disposable` PostgreSQL target, authenticates synthetic encrypted snapshots before its migrations and runs a whitelisted provider-free child environment.

Require the full local suite, actual build/runtime-import check and the native gate to pass on the exact candidate source before publication. Mock passes or previous-release native CI do not certify these new races. No incident race is to be tested against production.

The independent local backup runner repair updates only its approved canonical frontend expectation and self-tests. Exact source pins, production service/environment checks, database restrictions, gateway audience, disabled evidence cleanup, encrypted authentication and newest-30 retention remain unchanged. A fresh authenticated local encrypted production backup succeeded at 02:20:11 Asia/Manila on 12 October; it is not an off-site copy or successful restore drill.
