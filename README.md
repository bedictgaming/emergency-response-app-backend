# Emergency Response API

Production-oriented Express, TypeScript, Prisma, and PostgreSQL API for Cordova's emergency response system.

## Local setup

1. Copy `.env.example` to `.env` and supply the required credentials.
2. Run `npm ci`.
3. Run `npx prisma migrate deploy` and the appropriate seed scripts.
4. Start with `npm run dev`.

The API is served under `/api`. Liveness is available at `/healthz`; database readiness is at `/readyz`.

## Quality commands

- `npm run build` — TypeScript production build
- `npm test` — automated security, validation, and HTTP tests
- `npm run check` — build and tests
- `npm audit --omit=dev` — dependency review

## Security model

Roles are `USER` (citizen), `DISPATCHER`, `RESPONDER`, and `ADMIN`. Active account status is checked on every authenticated request. Citizen incidents require a Cloudinary asset that the backend independently verifies before the incident and attachment are committed atomically. Accepted incidents enter the active response workflow immediately.

Citizen reports also require a confirmed map coordinate. Before uploading evidence, the client calls `POST /api/incidents/v1/nearby-check` for a privacy-safe warning. Incident creation repeats the check under sorted service/area PostgreSQL transaction locks and rejects another OPEN/ACTIVE/RESPONDING incident with overlapping response services within 100 meters with `409 DUPLICATE_ACTIVE_INCIDENT`. There is no citizen daily report quota; short-term HTTP and upload anti-abuse limits still apply. Rejected duplicates create no incident or responder notification, and unreferenced verified proof uploads are queued for cleanup under the existing containment policy. Resolved or closed incidents do not block a new report; citizens cannot override duplicates.

The `Other` citizen category supports one multi-response incident with two or more `requestedServices` values from `FIRE`, `MEDICAL`, `POLICE`, and `HAZARD`. The incident is shown on every selected department dashboard, counted for each selected service, and targets active Main Admin, selected-service operational accounts and compatible on-duty responders through the current notification audience policy. It remains one incident for evidence, status, and audit purposes.

Never deploy with placeholder credentials. Production startup rejects missing database, JWT, frontend/backend URL, and Cloudinary configuration. Keep secrets in the hosting provider's secret store.

## Operations

Apply migrations with `npx prisma migrate deploy`. Back up PostgreSQL before every migration and regularly test restores. The in-process SSE event bus supports a single API instance; replace it with Redis/NATS when horizontally scaling. Device tokens are stored for push delivery, while actual FCM/APNs provider credentials must be configured by the operator.
