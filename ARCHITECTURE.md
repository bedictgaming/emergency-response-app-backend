# Backend architecture

Structure reference: [Chimairel/Kainara](https://github.com/Chimairel/Kainara/tree/d17b30482398472a02eefd505950f8b42af6b223/backend/src). Adapt domain/validation/middleware organization while preserving this system's service/repository, session and incident invariants.

```text
src/
  app.ts, server.ts                 # composition/runtime entrypoints
  routes/                          # paths and ordered middleware composition
  middleware/                      # authentication, gateway, origin, scope, limits
  controllers/                     # HTTP input/output, cookies and redirects
  validation/                      # Zod request schemas by resource
  services/                        # workflow orchestration and transactions
  domain/                          # dependency-light *.policy.ts rules
  repositories/                    # Prisma queries/persistence
  lib/                             # integrations/runtime/transaction adapters
  config/                          # validated environment
  generated/prisma/                # generated, not hand-authored
  utils/                           # existing focused helpers
prisma/schema.prisma, migrations/   # unchanged model/history
tests/, scripts/                   # contracts and guarded operators
```

Flow: route → authentication/authorization/validation → controller → service → repository or transaction adapter. Services retain direct transaction orchestration where required for atomic locks/audits/outbox; never split a transaction into independent repository calls merely for layering.

Policies may import policies, enum/type definitions and deterministic validation libraries, but not HTTP, database clients, repositories, provider transports or process environment. Runtime evidence-namespace configuration stays in `lib/evidence-scope.ts`. Type-only account-shape imports are permitted.

Controllers do not query the database. Logout revokes the same refresh value through a service/repository before clearing the same cookies. Evidence delivery retains route and service ownership checks before private metadata/signing, with the same 60-second access URL or 302 redirect. Raw storage identifiers are never public DTOs.

Preserve User → Token → Incident locking, current RBAC/session/access expiry, exact versions, audit/outbox atomicity, department-owned completion, confirmed-false disposition, private evidence, single-process SSE and exact raw-path gateway signatures. No schema, endpoint, provider, worker or hosting-policy change accompanies this refactor.

Remove unused retired Responder CRUD code and verification-only schemas/URL helper, not its authenticated 410 router, compatibility denial guards, historical models/enums/foreign keys, migrations or tests. Removal does not restore access or erase data.

`npm test` automatically runs architecture regressions. Also run build/native compiled imports and confirmed loopback synthetic PostgreSQL races without providers. Local verification never certifies production or third parties.

Daily backup paths, nine project pins, dependency closure, keys and runner are untouched. Do not move or repin these sources as routine cleanup. Root `MASTER_PROMPT.md` and `OPERATIONS.md` remain operational authorities; this guide is not publication evidence.

Unit retirement (14 October, local): unit/resource/incident-unit routers are authenticated no-store 410 compatibility boundaries, not CRUD/dispatch entrypoints. Nested incident-unit aliases retain current incident scope before 410. Historical schema and helpers remain; live dispatch permission is no longer granted. Report disposition/merge no longer depend on retired unit statuses and never fabricate Returned/Available; cancellation retains history, and deliberate deletion snapshots original assignments in its audit. Incident tasks and every authority/version/evidence gate remain. Staff arrange physical crews/vehicles outside the app. See root UNIT_RETIREMENT_2026-10-14.md; deployment is not authorized by this change.
