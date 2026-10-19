# Nearby report intake — development only

The new workflow is implemented in the local `development` frontend/backend pair. It has not been committed, pushed or deployed by this implementation task. The live production pair is unchanged.

## Run the prepared localhost demo

Use the development checkouts, not the older, dirty OneDrive copies. Keep any existing terminal/server under your control; these commands do not stop another running server.

Backend terminal:

```powershell
Set-Location -LiteralPath 'C:/Users/Lenovo/AppData/Local/Temp/er-email-verification-20261009/backend'
npm run nearby:prepare-local
npm run dev:nearby
```

Frontend terminal:

```powershell
Set-Location -LiteralPath 'C:/Users/Lenovo/AppData/Local/Temp/er-email-verification-20261009/frontend'
npm run dev
```

Open `http://localhost:3000`. If ports 8000/3000 are already occupied, stop your previous demo terminals first and restart from these folders. The guarded local bootstrap uses only the existing protected loopback database and dedicated development Google/photo credentials; no credentials belong in the repository or chat. Local development uses the existing Socket.IO WebSocket transport. Closed-tab Web Push requires its separate existing opt-in setup and actual-device acceptance.

Preparation refuses a hosted database, unknown migration drift, failed migration history or any pending migration other than `20261019130000_nearby_department_intake`. A Windows CRLF checkout is accepted only when its LF-normalized bytes match the already-recorded historical checksum. Old SQL, checksums and backup pins are never rewritten. Before applying the additive migration, preparation authenticates an encrypted lossless snapshot using the dedicated development key outside OneDrive. Already-prepared runs are read-only checks.

## Expected behavior

- A first admitted report remains in the normal response queue.
- A later distinct citizen report within exactly 100 m of an active, admitted original requesting the same service is received with its evidence, then pending for that service. Original selection follows receipt order, not nearest distance. Existing reports are not reclassified.
- Pending B remains visible in **Nearby reports awaiting department review** and outstanding alerts, but is absent from that department's regular response list.
- Only its currently assigned department ADMIN may **Acknowledge and admit report** or **Reject as fake — retain record**. Main Admin monitors; dispatchers cannot finalize decisions. Rejection requires a 10–500 character reason. Being nearby is not proof of a fake/duplicate emergency.
- Acknowledge admits B and records the alert/Main handoff without resolving it. A rejection affects only that service; other services retain their own decision and response. If every service rejects, the report is CANCELLED/REJECTED but remains retained with its evidence and audit history. Permanent deletion of linked intake reports/originals is blocked.
- A map's review links target its actual pending follow-ups, not unrelated older peers. Pins and 100 m distances remain recorded-coordinate estimates, not physical GPS accuracy or proof of one incident.
- Decisions emit post-commit `incident.updated` hints on the existing authenticated event server. They do not create a fresh `incident.created` or intentionally replay sirens for older reports.
- Existing evidence-ownership, submission retry/photo reuse protection and three-consecutive-report/five-minute account restriction remain. Test with clearly synthetic local reports and fresh, owned evidence; this is not real-user UAT.

The new intake decisions are final in this version. Correcting one requires a separately authorized, audited recovery workflow; do not edit database rows or silently disable the gate to bypass a decision. Existing Main-admin review/correction authority for older, already-admitted review flags is unchanged.

## Verification and later publication

Ordinary backend gates run with `NEARBY_REVIEW_ENABLED=false`. The existing native PostgreSQL gate retains all 81 previous contracts and runs the opt-in intake suite separately with the gate enabled, after an authenticated synthetic pre-migration snapshot. On Windows, `scripts/run-nearby-review-native.ps1` creates its own isolated cluster on the already-approved port 55433 and stops only that cluster; it never accepts the demo or live database as a test target.

The frontend has a separate `e2e/nearby-intake.spec.ts` opt-in suite, including the actual Socket.IO browser client against a synthetic Engine.IO peer. Mocked API/WebSocket tests do not certify physical-device/provider delivery or production behavior.

Local qualification on 19 October 2026 passed all 81 existing native PostgreSQL contracts plus 10 new intake contracts, including real HTTP/SQL, concurrent decisions, authorization, independent service decisions and retained evidence. All 9 opt-in Chromium cases passed against the WebSocket build, including all department scopes, Main read-only monitoring and event-driven updates with EventSource unavailable. The earlier 8-case SSE run and 46 existing alert/transport/push/worker checks also passed. Builds, TypeScript, scoped lint and the new UI's mechanical check passed. The Impeccable UI guidance informed explicit pending/read-only/error states, the required rejection reason and retained-history wording without redesigning the dashboards.

Final backend build/runtime verification and the ordinary suite passed: 102 files/926 tests passed; 14 native/opt-in files/127 tests were explicitly skipped in ordinary mode, not counted as passes. The separate native run above passed its 91 PostgreSQL contracts. The durable ordinary result is `C:/Users/Lenovo/AppData/Local/EmergencyResponse/nearby-intake-evidence-20261019/backend-final.json`.

Preserve non-accepting attempts separately: initial environment/Windows process/port-guard issues, the original local Turbopack build timeout, and the first WebSocket browser run's initial Fire page-load timeout. That first run had 8 passes/1 failure; its trace is retained outside the repository. The complete 9-case rerun used the same assertions and timeouts, no retries, one worker and the same built application. It passed; no global timeout, existing native guard or CI assertion was relaxed. Local webpack verification does not claim that the full hosted CI or its default bundler has run for this unpublished source.

The protected localhost migration completed only after its fresh encrypted snapshot authenticated. Existing reports were not backfilled. Application source remains uncommitted/unpushed, and no real-user UAT, physical-device notification delivery or production migration/release has been performed.

Future publication requires a separately approved production backup/migration and paired backend `NEARBY_REVIEW_ENABLED=true` plus frontend `NEXT_PUBLIC_NEARBY_REVIEW_ENABLED=true`, exact-source CI/release gates and live acceptance. Both feature opt-ins default off in published source; ignored local demo files select them on. Do not disable/roll back the gate while durable pending/rejected rows remain. No production migration, provider settings, source publication, platform upgrade or backup pin/key change has been performed here.
