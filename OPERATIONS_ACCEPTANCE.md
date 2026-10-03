# Release and monitoring acceptance

These checks do not authorize deployment, evidence deletion, real incident creation, email or push to real recipients. Keep dashboards supervised. A local mock, configured key, or empty queue is not proof of delivery.

## CI and dependencies

Each application repository now has its own `.github/workflows/ci.yml`. Commit/push and confirm actual Actions results before claiming remote CI is active; configure required branch checks separately. Backend CI uses an unreachable dummy database and disables the opt-in integration suites. Frontend CI uses a local mocked export, not a live deployment mode. No cloud secrets belong in pull-request jobs. Database integration, deployment and migration remain separate gates; take and verify an encrypted backup before any applied migration.

Run `node scripts/check-dependency-audit.mjs` in each repository. It fails on runtime advisories, new advisories or an unavailable audit. The sole known build-only exception is [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), unpatched at review on October 3, 2026. This is containment, not remediation. Its explicit exception expires October 17, 2026. Do not accept untrusted glob patterns. Review upstream before expiry; do not force major dependency downgrades. Backend runtime image uses production-only dependencies, copies compiled Prisma and mail templates, and runs as `node`; CI must build that image on Linux before release.

## Health and queues

Monitor anonymous `/healthz` and `/readyz` at a modest interval (e.g. one minute), with a client deadline of five seconds. Alert on three consecutive failures or repeated bursts; record timestamp, endpoint, HTTP status, latency and sanitized request ID. Separate a transport/TLS failure from a 503 database dependency failure. Do not restart/redeploy blindly or repeatedly probe at high frequency. Correlate with Railway deployment/instance events, database-pool logs and database-provider status; this code does not establish the cause of historical network failures.

`/readyz` tests only database reachability. New code returns within three seconds, shares one in-flight check and briefly caches results; a timeout does not cancel its underlying query. Connection acquisition is bounded at ten seconds. It does not certify SMTP, Cloudinary, push, replicas or capacity.

An authorized operator can run `npx tsx scripts/inspect-operations.ts --read-only` against the deliberately selected environment. This reads only notification-outbox aggregates and the oldest unfinished timestamp. It never drains/retries jobs, deletes assets or exposes recipients/payloads/IDs/last-error strings. Exit 1 means exhausted retries, oldest unfinished age over fifteen minutes, or inspection failure. Configure your operator scheduler/monitor separately; merely adding this script does not schedule it. Investigate failures against the dashboard response process; do not requeue potentially delivered work blindly. Check missing keys/disabled worker independently.

## Daily backup acceptance

Verify the actual daily schedule, last success, key custody and off-site copy. On the latest authorized encrypted file, run:

```
npx tsx scripts/verify-encrypted-backup.ts <exact-backup.json.enc> --max-age-hours 26
```

This validates AES-GCM authentication, JSON/table structure and backup age without printing private rows. Without the age flag it validates an historical file but does not demonstrate daily freshness. A metadata timestamp alone is insufficient. Confirm a restore into an explicitly disposable database and reconcile table/report counts; do not restore into production. Keep keys and decrypted contents out of Git, logs and support tickets. No automated daily job or off-site backup is created by this change.

## Real delivery acceptance (separate authorization required)

Use isolated staging with synthetic accounts and a contact/device controlled by the operator. First confirm staging namespace, disabled shared-storage deletion and non-production recipients. Agree on a single explicitly labeled test, target department, expected recipients and no-dispatch procedure before any send. Confirm citizen acknowledgement, correct department receipt, other-department absence, stream reconnect and enabled sound. Independently confirm email in the controlled inbox and push on the physical device with the app foreground/background as relevant. Inspect outbox outcomes and failure/retry behavior. Provider acceptance does not prove user receipt. Record only sanitized results/times and retain audit history.

If those tests are not authorized or verified, state delivery remains unverified and retain continuous dashboard coverage. Peak capacity, multi-replica fanout, sustained soak and failover certification are not part of these local checks.
