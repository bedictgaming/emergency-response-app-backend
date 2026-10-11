# Production custom domain — 11 October 2026

Canonical app: https://cordova-emergency-response.site. Preserve the existing
https://cordova-emergency-response.vercel.app production alias without redirecting it.
Both aliases use the same production user records, RBAC, incident workflow and schema.
No schema migration or account/session reset is part of this release.

Production FRONTEND_URL and BACKEND_URL become the canonical .site origin;
ADDITIONAL_FRONTEND_ORIGINS retains the exact old Vercel origin. Keep COOKIE_DOMAIN
unset: these unrelated hosts cannot safely share cookies. Existing old-host sessions
remain valid; users sign in once on the new host. Password-reset emails use canonical
FRONTEND_URL, preserving generic responses, expiry, single use and session revocation.

The gateway v2 proof authenticates request.url.origin along with all existing v1
request/IP/credential/CSRF fields. The backend accepts v1 during rolling deployment,
never downgrades a proof carrying v2 metadata, and strips proof headers. Only verified
v2 metadata in res.locals plus the exact origin allowlist can select an OAuth callback
and destination; never Host, forwarded host, Origin, Referer or a returnUrl query.
Legacy v1 production proofs retain the old Vercel callback when that origin is trusted.
Unrecognized candidate hosts fall back to canonical; this is not a full OAuth test
because candidate-host state cookies cannot follow to the canonical host.

Register the new /api/auth/v1/google/callback in the existing production Google client,
keeping the old registration. Pass callbackURL per request to Passport at both
authorization and code exchange; never mutate the shared strategy. Settings linking
uses the same selected callback and preserves its password/session-bound S256 intent.
CORS reflects only exact trusted origins, with credentials and Vary: Origin. CSRF
origin validation remains in front of mutations. Gateway attestation is not RBAC.

Release gates: exact-source local build/contracts and CI, archived tracked source only,
backend compatibility first, production frontend candidate before promotion, then
canonical production environment cutover. Preserve database/provider/gateway secrets,
worker and evidence-cleanup flags, staging and platform protections. Verify both aliases,
health/readiness, unauthenticated boundaries, state cookies, per-host Google redirect,
CSP/no-store, camera-only and account-settings bundles. Anonymous/mock checks do not
prove real Google exchange, mail delivery, authenticated admin access or physical
iPhone/Android behavior. User acceptance on the new address remains necessary.
