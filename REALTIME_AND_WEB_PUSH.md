# Development candidate: Socket.IO and admin Web Push

This source update is for the `development` branch. Publishing source is not a production deployment or approval to change live credentials, gateway configuration, notification workers or dependency-audit exceptions. Use the matching frontend candidate. The workspace's `MASTER_PROMPT.md` remains the canonical engineering reference.

## Realtime transport

### Nearby submitted-report detection (local candidate, 18 October)

`POST /api/incidents/v1/nearby-detection` is an authenticated read-only/no-store lookup, rate-limited to 150 requests/minute/account. Strict citizen bodies contain `{kind:'citizen',latitude,longitude,services}`; strict operational bodies contain only `{kind:'department',incidentId}`. The server owns the latter's authorized selected-report center and matching services. Both center and candidates retain current department/Main scope. Exact 100m haversine checks follow a bounded spatial prefilter in RepeatableRead; reject/merge/confirmed-false/completed work is excluded. Citizens receive only presence/unknown/completeness, excluding their own reports, with no peer IDs, counts, coordinates or evidence. Operations receive at most 50 minimal authorized pins; full report/evidence inspection still uses the existing guarded read. A 200-candidate limit with lookahead must return incomplete/unknown rather than a false all-clear.

The existing stream account/session/expiry/backpressure checks now call a per-actor presenter. Authorized ordinary events are unchanged. An otherwise unreadable incident event may produce only `{type:'nearby.changed'}` for a citizen, without a peer identifier or timestamp. This generic recheck hint may reflect activity anywhere; it is not proof of a nearby incident and is not an ordinary report/siren event. The following authenticated spatial read is authoritative. No normal event ACL, client rooms/commands, transport configuration, Web Push/outbox/worker, acknowledgement, submission/routing, duplicate protection or schema is changed. Publish the matching backend before any future frontend release; this paragraph does not authorize deployment or certify production/provider/device behavior.

### New-report-only siren metadata

The owner approves deploying the matching new-report alert refinement. GET /api/incidents/v1/attention now includes observedAt from PostgreSQL CURRENT_TIMESTAMP in the existing authorized RepeatableRead transaction, even for empty queues. This additive read-only field does not change queue scope, the fifty-item bound/hasMore, report state, versioned acknowledgement or Main department handoff. Native provider-free PostgreSQL HTTP contracts cover the database-owned timestamp for all five admin scopes, including empty departments. No schema migration or new endpoint is introduced.

The matching client uses a quiet first-success baseline and only an unseen report ID reported after that baseline automatically alarms. Old queued/paginated records, refresh/reconnect/navigation and status/version/reopen changes do not impersonate new submissions. Existing outstanding work remains visible for manual review and deliberate Unmute; no automatic acknowledgement is performed. Publish/accept this backend metadata before the matching frontend. Preserve production SSE, development Socket.IO, Web Push/outbox/audiences/worker/key/configuration and every existing release gate. Source publication and mocked/native contract tests alone are not production/authenticated operator-device or UAT acceptance; consult the workspace MASTER_PROMPT.md for current release status.

- Socket.IO 4.8.4 attaches to the existing HTTP server at `/api/events/v1/socket.io`, WebSocket-only. SSE remains available at `/api/events/v1/stream`.
- The upgrade reuses the same gateway guard/replay state, trusted-origin policy, current cookie/session authentication and process/account capacity as the existing HTTP/SSE boundary. It must not bypass the production gateway.
- Current account status, session, expiry and role/department/Main authority are rechecked for events and heartbeats. Connections reauthenticate after at most 60 seconds. There are no client commands, client-selected rooms, private report payloads or tokens in socket URLs.
- Events invalidate authorized HTTP reads; the database, existing write APIs, incident workflow and concurrency controls remain authoritative. The emitter is single-process, not a distributed replay bus or exactly-once guarantee.

## Background notifications

- Existing transactional outbox, device registration, relevance/privacy checks, fenced retry progress and notification worker are retained.
- `GET /api/notifications/v1/web-push-key` advertises capability only when both VAPID keys and `BACKGROUND_JOBS_ENABLED=true` are present. Its public reason is `not-configured`, `worker-disabled` or null. Capability is not provider delivery or worker-liveness certification.
- The matching shared admin header lets Main, Fire, Medical, Police and DRRMO explicitly opt in. Routing remains Main plus the assigned department(s), not every admin. Generic lock-screen hints contain no report evidence/location/identity.
- Private VAPID keys stay in approved server-only configuration. Do not copy production keys for development. Logout/revocation/current authority and notification expiry/relevance still apply.
- Workers process already queued jobs. Never enable them against an unreviewed existing database. Evidence deletion and orphan sweeping remain disabled during local notification tests.

## Controlled local test

The owner's workspace uses a separately approved synthetic database, new development VAPID/JWT keys and a loopback-only runtime. Its local operator/private files are not part of this public source commit. The ordinary primary development bootstrap remains worker-disabled; Git checkout alone does not activate notifications.

Use the matching API on `http://localhost:8000` and frontend on `http://localhost:3000`; do not mix localhost and 127.0.0.1 cookies. Enable `NEXT_PUBLIC_ENABLE_DEV_PUSH=true` only for the documented loopback push-only frontend worker. It must not intercept/cache Next development assets or API data. Never use production data/providers as a shortcut.

On each admin's separate normal browser profile/device: sign in, enable notifications, Allow, then close the tab without logging out. Submit one clearly synthetic report from a separate citizen session. Record actual Main/assigned-department receipt and unrelated-department nonreceipt. Keep the backend, browser/PC and internet available. An Android phone cannot access the laptop's localhost; plain LAN HTTP is not a secure phone push setup. Device-reachable HTTPS needs separate authorization/configuration.

## Qualification and remaining gates

Local backend build/native ESM checks, authenticated loopback Socket.IO contracts and notification capability/audience regressions passed during development. Database/provider operations in ordinary unit suites are mocked unless explicitly identified otherwise. Frontend transport/cache/push-worker and browser contracts are recorded separately. Local readiness and a development photo API ping are not a citizen submission, FCM/OS receipt, sound guarantee or participant UAT.

Fresh publication qualification passes the backend build/native ESM check and all 853 ordinary tests, with 99 opt-in integration tests skipped. The matching frontend passes types, full lint and 74 contracts. These are local checks, not hosted CI or live acceptance.

Production still defaults to the existing SSE frontend transport. Hosted authenticated WebSocket ingress and physical Android/Chrome closed-tab push receipt remain unverified. The initial publication's audit failures are retained, not described as green. SMS is not implemented.

## Explicit release approval (17 October 2026)

After reviewing the remaining unpatched build-only advisory, the owner explicitly approves a temporary exception solely for GHSA-vfj7-8cjw-p6xm until **19 October 2026, 23:59 Asia/Manila** (`2026-10-19T15:59:00Z`) and requests live Web Push deployment while retaining development operation. This is not a dependency fix or a general audit exemption. Runtime advisories, unrelated build findings, unavailable audits and expiry still fail. Seven policy contracts exercise these boundaries in CI before the actual audit. All other build/test/native/browser/release gates remain required.

Release preserves production's existing VAPID keys, enabled worker, gateway/host-only cookies and SSE frontend transport. No live key rotation, database migration, private report mutation or SMS configuration is included. Enablement requires an admin's explicit browser permission. Actual Main/assigned-department closed-tab Android receipt and OS sound must be verified on the owner's device after deployment; passing builds/mocked tests are not that evidence.
