# Project TODO

## Phase 1 — Security, validation, and ownership
- [x] Validate trip duration, dates, timezone/DST, coordinates, stop counts, and generation-option ranges at API/service boundaries.
- [x] Enforce ownership checks on trip, feedback, saved-stop, and sharing endpoints; only explicit share-token access is public.
- [x] Make email-code cooldown, attempt counting, and one-time use safe under concurrent requests.
- [x] Require production email configuration and prevent verification codes from falling back to logs.
- [x] Add an explicit trusted-proxy CIDR setting; never trust forwarded headers by default.
- [x] Use Vercel's client-address header for rate limits on Vercel.
- [ ] Configure a shared rate limiter (e.g. Upstash Redis) so limits hold across instances.
- [x] Sign out other sessions on password reset; reject tokens for deleted accounts.
- [x] Hide private notes from shared links; allow turning sharing off.
- [ ] Complete auth/CORS/health production-default review.

## Phase 2 — Generation reliability and quota control
- [x] Implement atomic, durable quota reservation before enqueueing expensive generation jobs.
- [x] Release quota and fail the trip if queue admission fails.
- [x] Scan and requeue stale jobs on persistent API hosts; serverless deployments recover when generation is requested again.
- [x] Fence duplicate/stale generation workers and condition terminal transitions on the active attempt.
- [ ] Define a bounded transient-provider retry policy and test retry/error normalization.
- [ ] Verify provider timeout and partial-failure handling across route and AI steps.

## Phase 3 — Architecture cleanup and modularization
- [x] Separate feedback routes into a dedicated feedback module.
- [x] Separate place autocomplete/details into a dedicated places module.
- [ ] Keep planning/domain logic independent from providers and persistence.
- [x] Extract health and integration-check routes into a dedicated health module; preserve route contracts.

## Phase 4 — Accommodation and trip-cost features
- [x] Include an on-demand photo metadata URL for Google-backed recommended stops.
- [ ] Implement trip stop image cards in the client app using `docs/PLACE_IMAGES_UI_INTEGRATION.md`, including author/Google attribution, lazy loading, and graceful fallbacks.
- [ ] Add camping locations and campground options with pricing filters and availability assumptions.
- [ ] Add hotel and resort options with nightly-rate and total-trip budget calculations.
- [ ] Validate accommodation choices against trip budget, route proximity, and overnight constraints.
- [ ] Keep unknown fees explicit and non-zero instead of silently undercounting costs.

## Phase 5 — Cost instrumentation and membership readiness
- [ ] Instrument Google and AI usage per generation and reconcile against billing estimates, including on-demand Place Photo metadata/media lookups.
- [ ] Define Pro entitlements, fair-use quotas, cancellation/grace/refund policy, and enforce all entitlements server-side (Stripe web memberships now update the server-owned plan; current Pro generation quota remains unbounded).
- [x] Add user profile and membership modules with Stripe checkout/portal APIs, signed/idempotent webhooks, and subscription persistence.
- [ ] Configure Stripe products/prices, webhook deployment secrets/events, and run test-mode lifecycle verification.
- [ ] Build the web pricing, upgrade, usage, and manage-subscription UI.
- [ ] Confirm launch readiness against the engineering audit checklist and PR sequence.

## Phase 6 — Adaptive itinerary
- [x] Add a review-before-apply late-arrival flow to the web and mobile trip screens.
- [x] Re-route the final destination leg to nearby lodging, preserve Undo, and shift later destination-day start times.
- [ ] Extend adjustments to arbitrary trip days, round trips, fly + drive, and free-form chat intents.