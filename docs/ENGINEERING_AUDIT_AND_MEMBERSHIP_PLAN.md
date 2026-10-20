# Travlio Roadtrip Planner — Engineering Audit, Target Structure & Membership Plan

> Consolidated engineering risks, a proposed NestJS structure, and a membership implementation plan. Items marked **Verify** should be rechecked against the current branch and deployment configuration. The proposed structure is a target, not a claim that every file already exists.

## 1. Executive summary

Prioritize before scaling or accepting payments:

1. Input validation, authentication, authorization and ownership checks.
2. Reliable generation jobs, atomic quota reservation and recovery of stuck jobs.
3. Complete Google/AI cost instrumentation and enforceable spending limits.
4. Clear boundaries between trip CRUD, planning, generation, provider clients and supporting features.
5. Server-authoritative membership, subscription lifecycle, entitlements and billing webhooks.

Priority levels: **P0** critical security/data integrity; **P1** resolve before public launch or paid subscriptions; **P2** maintainability/operations; **P3** later optimization.

### 1.1 Project-specific near-term priorities

This roadmap is grounded in the current Travlio road-trip planner product scope and should be treated as the starting point for the next implementation waves:

- Add camping locations, campgrounds and overnight stop options with clear pricing and availability assumptions.
- Add hotel and resort options with nightly-rate and total-trip budget calculations, including taxes/fees where relevant.
- Show imagery for recommended places with required Google Maps and photo-author attribution; the API now exposes an on-demand metadata URL, while app UI rendering remains to be implemented.
- Keep cost estimates explicit and non-zero when fees are unknown; do not silently undercount accommodation or parking.
- Separate accommodation search from route planning so that route generation can rank, filter and budget each stay type consistently.
- Treat accommodation and trip-cost features as first-class stop categories in the planner, not as ad hoc search results.

## 2. Current issues and risks

### 2.1 Input validation and planning

| ID | Priority | Issue / risk | Recommended fix |
|---|---|---|---|
| INPUT-01 | P1 | Trip duration and stop count need strict upper bounds; oversized requests can increase latency and provider/AI costs. | DTOs validate a 14-calendar-day cap, waypoint count, coordinate ranges and bounded generation options; generation reparses saved requests before planning. |
| INPUT-02 | P1 | Invalid dates, end-before-start and timezone ambiguity can produce inconsistent itineraries. | Validate ISO/calendar dates and ordering. Resolve route departure times in the origin/destination timezone; reject nonexistent spring-forward times and choose the earlier instant for repeated fall-back times. |
| PLAN-01 | P1 | Route alternatives and return-route behavior can diverge if the selected route is not preserved through planning. | Model outbound/return legs explicitly and derive stop candidates from the selected route geometry. Test one-way and round-trip flows. |
| PLAN-02 | P1 | Reliable toll-aware cost estimation is not established in the current implementation. | Do not advertise toll-inclusive totals until route requests, returned toll data, vehicle assumptions, fallback behavior and tests are implemented. |
| PLAN-03 | P2 | Large candidate sets and long trips can increase latency and cost. | Bound trip length and candidates per leg/day; add provider timeouts and staged retrieval where needed. |
| PLAN-04 | P2 | Candidate retrieval, AI selection, narrative generation and persistence are coupled. | Separate orchestration from provider adapters and persistence. Validate AI output and allow only known candidate IDs. |
| PLAN-05 | P1 | Accommodation options (campgrounds, hotels, resorts) need explicit stop typing and budget treatment to avoid mixing them with activity suggestions. | Add typed accommodation categories with normalized pricing, occupancy assumptions and overnight budget totals. |

### 2.2 Authentication, authorization and abuse prevention

| ID | Priority | Issue / risk | Recommended fix |
|---|---|---|---|
| AUTH-01 | P0/P1 | Email verification may be bypassed or unavailable if mail delivery is misconfigured. **Verify** SES credentials and sending permissions in deployment. | Production startup requires `EMAIL_FROM` and an SES region; console logging of verification codes remains development-only. |
| AUTH-02 | P1 | Email-code issuance and attempt counters may race under concurrent requests. | Store code hashes/expiry; serialize issuance and resend cooldown per account/purpose, atomically increment attempts, and condition one-time consumption on the remaining attempt count. Unit tests cover concurrent attempts and consumption; confirm behavior against PostgreSQL before deployment. |
| AUTH-03 | P1 | Resource-ID endpoints such as feedback may not consistently verify trip ownership. | Trip reads, updates, deletes, generation and share-token writes are owner-scoped; feedback verifies ownership before insertion; saved-stop lookup filters by owner. Shared-trip reads remain public only by unguessable share token. |
| AUTH-04 | P1 | Blind trust of X-Forwarded-For permits IP spoofing and undermines throttling. | Configure Express trust only for explicit proxy IPs/CIDRs using `TRUSTED_PROXY_CIDRS`; otherwise use the socket address and never consume arbitrary forwarded headers. The config hook is implemented; deployment values still need verification. |
| AUTH-05 | P1 | In-memory rate limits do not enforce global limits across multiple instances. **Verify** current storage. | Use Redis-backed limits plus account/IP throttles for login, verification, generation and expensive lookups. |
| AUTH-06 | P1 | Duplicate registration can race if uniqueness is checked only in application code. | Add database uniqueness constraints and handle conflicts safely. |
| AUTH-07 | P1 | JWT, CORS, secrets and health endpoints need production-safe defaults. | Validate configuration at startup, require strong secrets, restrict CORS and expose minimal public health details. |
| AUTH-08 | P2 | IP throttling alone may not prevent abuse from account farms or rotating IPs. | Add account quotas, verified-account requirements, concurrency limits and spend alerts. |

### 2.3 Background jobs and generation

| ID | Priority | Issue / risk | Recommended fix |
|---|---|---|---|
| JOB-01 | P1 | Concurrent generation requests may race on quota checks or state transitions. | Reserve quota atomically before enqueueing, with durable usage records and idempotency keys. |
| JOB-02 | P1 | Queue enqueue failure can leave a generation marked queued without a worker job. | Use safe transitions or a transactional outbox; mark failure and reconcile/release reservations if enqueue fails. |
| JOB-03 | P1 | Jobs can remain stuck after worker crashes or deployments. | Record queue/start/heartbeat timestamps, attempts and last error; recover stale jobs. |
| JOB-04 | P1 | Retries can duplicate outputs or quota usage. | Stable database generation IDs, per-attempt fencing and conditional terminal transitions prevent stale workers from committing duplicate output or quota usage. Define and test a bounded retry policy for transient provider errors before enabling provider-level retries; current planner failures are terminal and require a user retry. |
| JOB-05 | P1 | Provider timeout, rate-limit and partial-failure behavior needs a defined contract. | Add timeouts, normalized errors, bounded retries and safe persisted error codes. |
| JOB-06 | P2 | Queue backlog and generation failures need visibility. | Track queue depth/age, duration, retries and failure rate; alert on stuck jobs. |

### 2.4 Google Maps and AI costs

| ID | Priority | Issue / risk | Recommended fix |
|---|---|---|---|
| COST-01 | P1 | Metering covers selected Google operations but may omit billable Autocomplete, Place Details and on-demand Place Photo usage. | Record every billable operation, including image metadata/media requests, and reconcile estimates against Google Cloud billing exports. |
| COST-02 | P1 | Places Text Search requests ratings, review counts and opening hours, potentially triggering a higher SKU. | Request only fields the product uses; separate essential lookup from optional enrichment. |
| COST-03 | P1 | AI estimates depend on whether the fast Bedrock model is configured and on actual model pricing. | Record model ID, input/output tokens, latency and estimated cost per generation. Verify current prices and fallback behavior. |
| COST-04 | P1 | Free-tier assumptions are not hard cost controls. | Label figures as estimates, reconcile against billing and configure spend alerts independent of free tiers. |
| COST-05 | P1 | Per-trip limits may not prevent bursts of expensive concurrent requests. | Add daily/monthly user budgets, concurrency limits, circuit breakers and server-side spend guards. |
| COST-06 | P2 | Provider usage may not be attributable to one generation across route, place and AI steps. | Correlate usage events with request/generation IDs and aggregate cost per generation. |
| COST-07 | P2 | Provider rate limits/failures can create unpredictable experiences. | Normalize errors, use bounded retries, cache only where provider terms permit and communicate partial-result states. |

> Google pricing, free caps and model prices change. Verify current prices and billing exports before using estimates for pricing decisions.

### 2.5 Data, privacy and architecture

| ID | Priority | Issue / risk | Recommended fix |
|---|---|---|---|
| DATA-01 | P1 | Ownership checks can be missed on endpoints accepting resource IDs. | Enforce ownership/visibility in every service operation. |
| DATA-02 | P1 | Quota and generation state may span independent writes. | Use transactions or idempotent state machines with reconciliation. |
| DATA-03 | P1 | Registration, verification and billing need database-level uniqueness guarantees. | Add unique constraints and handle duplicate-key races. |
| DATA-04 | P2 | Orphaned jobs and generation attempts can accumulate. | Define retention for transient job metadata separately from trip history. |
| DATA-05 | P2 | Shared trips need a privacy model if sharing is enabled. | Use unguessable share tokens, explicit visibility, revocation and expiry. |
| DATA-06 | P2 | Provider payloads and AI output can be malformed or contain unexpected IDs/content. | Validate schemas, normalize coordinates/IDs, reject unknown stop IDs and safely render text. |
| DATA-07 | P2 | Backup/restore, migrations, retention and account deletion need runbooks. | Test restore and document deletion/anonymization and retention. |
| ARCH-01 | P1 | A catch-all file/module such as misc.ts mixes unrelated responsibilities. | Split feedback, places and health into feature modules with dedicated controllers/services/DTOs/tests. |
| ARCH-02 | P1 | Trip CRUD and asynchronous AI generation have different lifecycles. | Separate trip resource management from generation orchestration and workers. |
| ARCH-03 | P2 | Provider logic, metering and planning need clearer boundaries. | Put providers behind adapters; centralize usage and error normalization. |
| ARCH-04 | P2 | DTO validation and error responses can become inconsistent. | Standardize validation, error shape, request IDs and API documentation. |
| ARCH-05 | P2 | Critical edge cases need regression tests. | Test dates, ownership, quotas, idempotency, queue failure and provider timeouts. |
| ARCH-06 | P2 | Environment configuration may be permissive or scattered. | Validate typed config at startup; separate environments; never commit credentials. |

### 2.6 Membership and monetization gaps

| ID | Priority | Issue / risk | Recommended fix |
|---|---|---|---|
| MEMBER-01 | P1 | A client-side isPro flag cannot securely grant access. | Build server-authoritative entitlements; client state is display-only. |
| MEMBER-02 | P1 | Subscription lifecycle and webhook behavior are not fully specified. | Verify webhooks, deduplicate events and normalize provider subscription states. |
| MEMBER-03 | P1 | Generation limits need atomic membership enforcement. | Add a quota service used by every generation request. |
| MEMBER-04 | P1 | Cancellation, renewal, failed payment, refund and grace-period behavior can diverge. | Define a state machine and reconcile with authoritative provider state. |
| MEMBER-05 | P1 | Billing provider, CAD pricing, taxes, receipts and app-store rules need a decision. | Confirm web vs Expo/native purchase surfaces before implementation. |
| MEMBER-06 | P2 | Hard-coded plan limits can become inconsistent. | Centralize entitlements and use one policy service. |
| MEMBER-07 | P2 | Users need a reliable view of plan, renewal date and quota. | Add membership, usage and subscription-management APIs. |
| MEMBER-08 | P1 | Spoofed or duplicated webhooks could grant/revoke access incorrectly. | Verify signatures against required raw body, deduplicate event IDs and make handlers idempotent. |

## 3. Implementation phases

### Phase 0 — Secure and stabilize
- [x] Validate dates, duration, coordinates and generation options at API and service boundaries.
- [x] Verify/fix ownership checks across trips, feedback, saved stops and sharing; mutation queries are owner-scoped and unknown/non-owned trips return not found.
- [x] Make email verification and production configuration fail safely; SES configuration is required in production and verification never falls back to logs.
- [ ] Configure trusted proxies and Redis-backed rate limits.
- [x] Make quota reservation and generation transitions atomic.
- [x] Release reservations and fail the trip when queue admission fails.
- [x] Scan and requeue stale jobs on persistent API hosts; serverless deployments recover them when generation is requested again.
- [ ] Add regression tests.

### Phase 1 — Refactor without changing behavior
- [ ] Introduce feature-first modules and provider adapters.
- [ ] Split catch-all modules into trips, generation, places, feedback and health.
- [ ] Separate trip CRUD from generation orchestration.
- [ ] Add consistent errors, request IDs and structured logs.
- [ ] Complete provider metering and per-generation cost attribution.
- [ ] Document migrations, backups and recovery.

### Phase 2 — Membership foundation
- [x] Choose billing provider and purchase surfaces: web checkout with Stripe for the initial integration; mobile store billing remains out of scope.
- [ ] Define plan catalog and entitlements.
- [x] Add subscription and webhook-event migrations; usage entitlement limits are still pending product definition.
- [ ] Implement server-side entitlement and atomic quota services.
- [x] Implement signed, deduplicated Stripe webhook handling for subscription state. Reconciliation and additional lifecycle tests remain.
- [x] Add membership status and usage APIs; per-plan usage entitlements remain pending.
- [ ] Test renewal, cancellation, failed payment, refunds, duplicate events and quota races.
- [ ] Build pricing, upgrade, manage-subscription and usage UI.

### Phase 3 — Growth
- [ ] Track activation, completed trips, repeat use, retention and generation success.
- [ ] Add relevant, clearly disclosed affiliate recommendations.
- [ ] Introduce sponsorships/ads only after retention is validated.
- [ ] Review provider costs and margins monthly.

## 4. Recommended NestJS backend structure

### 4.1 Design principle

Use a **modular monolith organised around the code that already exists**. The current application uses NestJS, Drizzle ORM, PostgreSQL/PostGIS, Zod validation, and BullMQ/Redis support. Do not introduce TypeORM-style repositories/entities, duplicate the domain layer, or create a directory for every class just to make the tree look enterprise-ready.

Keep the current working modules and refactor incrementally. The tree below is the **target after gradual cleanup**, not a requirement to move every file in one large change.

### 4.2 Target structure

```text
src/
├── main.ts
├── app.module.ts
│
├── config/
│   └── env.ts                    # Environment schema, parsing and validation
│
├── common/
│   ├── rate-limit.ts
│   ├── zod.pipe.ts
│   ├── errors/                   # Add only shared error mapping when needed
│   └── logging/                  # Add request/correlation IDs when implemented
│
├── db/
│   ├── db.module.ts              # Drizzle/Postgres connection and DB token
│   ├── schema.ts                 # Drizzle table definitions
│   └── migrate.ts
│
├── auth/
│   ├── auth.ts                   # Auth module/controller/service initially
│   ├── auth-schema.ts            # Auth-specific validation schemas
│   └── mailer.ts
│
├── users/                        # Extract when user/profile logic grows
│   ├── users.module.ts
│   ├── users.controller.ts
│   └── users.service.ts
│
├── trips/
│   ├── trips.module.ts
│   ├── trips.controller.ts
│   ├── trips.service.ts
│   ├── generation/               # Generation use cases and lifecycle
│   │   ├── generation.service.ts
│   │   ├── generation.processor.ts
│   │   └── generation-recovery.service.ts
│   └── dto/                      # Request/response schemas only when useful
│
├── planning/
│   ├── planner.ts                # Application-level planning orchestration
│   ├── stops.ts
│   ├── travel-options.ts
│   ├── route-costs.ts
│   └── fly-drive.ts
│
├── core/                         # Framework-independent domain algorithms/types
│   ├── types.ts
│   ├── itinerary.ts
│   ├── feasibility.ts
│   ├── costs.ts
│   ├── geo.ts
│   ├── time.ts
│   ├── timezone.ts
│   ├── weather.ts
│   └── sun.ts
│
├── providers/
│   ├── providers.module.ts
│   ├── google.ts
│   ├── place-search.ts
│   ├── weather.ts
│   ├── flights.ts
│   ├── fx.ts
│   ├── llm.ts
│   └── ...                       # Keep existing provider adapters together
│
├── feedback/
│   ├── feedback.controller.ts
│   └── feedback.module.ts
│
├── places/
│   ├── places.controller.ts
│   └── places.module.ts
│
├── health/
│   ├── health.controller.ts
│   ├── health.module.ts
│   └── integrations.controller.ts
│
├── membership/                   # Add when membership work starts
│   ├── membership.module.ts
│   ├── membership.controller.ts
│   ├── membership.service.ts
│   ├── entitlements.service.ts
│   ├── quota.service.ts
│   ├── billing/
│   │   ├── billing-provider.interface.ts
│   │   ├── webhook.controller.ts
│   │   └── webhook.service.ts
│   └── dto/
│
└── analytics/                    # Only when product analytics has real use cases
```

### 4.3 Responsibilities and boundaries

| Area | Owns | Must not own |
|---|---|---|
| `auth` | Registration, login, email verification, password reset, JWT/session validation | Trip planning or billing decisions |
| `users` | User profile and account lifecycle | Password verification implementation duplicated from auth |
| `trips` | Trip CRUD, ownership, sharing policy and persisted trip state | Raw Google/LLM request construction |
| `trips/generation` | Starting generation, job state transitions, retries/recovery and generation records | Provider-specific HTTP details |
| `planning` | Use-case orchestration for route, candidate stops, costs and itinerary assembly | HTTP controllers or direct client response formatting |
| `core` | Pure algorithms, domain types, calculations and deterministic validation | NestJS decorators, database queries or external API calls |
| `providers` | Google, weather, flight, FX and LLM adapters; normalized responses/errors | User entitlements, quota policy or trip ownership |
| `db` | Drizzle connection, schema and migrations | Business workflows or HTTP logic |
| `membership` | Plans, subscriptions, entitlements, quota policy and billing webhook orchestration | Trusting a client-provided `isPro`/plan value |
| `common` | Small, genuinely cross-cutting NestJS utilities | Feature-specific business logic |

### 4.4 Specific changes from the current code

1. **Keep Drizzle as the persistence approach.** The current schema is in `src/db/schema.ts`; use Drizzle queries and typed database helpers. Do not add TypeORM entities or a repository class for every table by default.
2. **Keep `core/` framework-independent.** Continue placing pure routing, feasibility, cost, itinerary and time calculations there. It should not import NestJS, Drizzle, Redis, Google SDKs or Bedrock clients.
3. **Keep `planning/` separate from `trips/`.** Planning builds a plan; trips owns the saved trip and its lifecycle. The generation workflow coordinates the two.
4. **Split the former `misc.ts` by responsibility, not by arbitrary class count.** Feedback now lives in `feedback/`, place search/details in `places/`, and health plus integration checks in `health/`; all modules are registered in `app.module.ts`. Preserve their existing routes and response shapes. Keep integrations in their own module only where they are a distinct feature.
5. **Avoid a premature `users/` module.** Extract it when profile/account operations justify the boundary; authentication can continue owning login and verification meanwhile.
6. **Keep queue code beside generation.** Reuse the existing BullMQ/Redis configuration. Do not create a generic queue abstraction until a second real use case needs it.
7. **Add membership only when implementing it.** First settle the billing provider and web/native purchase surfaces. Keep subscription state and quota enforcement server-side, and make quota reservation atomic with generation admission.
8. **Do not add empty folders for hypothetical features.** Add health, analytics, saved-stops or sharing modules when there is actual route/domain behavior to move into them.

### 4.5 Dependency direction

```text
HTTP controllers
      ↓
Feature use cases (trips, generation, membership, places, feedback)
      ↓
Planning/domain logic (planning → core)
      ↓
Provider adapters and database access
```

This is a dependency guide, not a requirement for every feature to have every layer. In particular, `core/` must remain independent of infrastructure. Providers and persistence should be called through focused services from use cases; provider adapters must not import trip or membership policy.

### 4.6 Safe migration order

- [x] **Step 1:** Add or improve tests around the existing miscellaneous routes and module registration.
- [x] **Step 2:** Extract `FeedbackModule` without changing endpoint contracts.
- [x] **Step 3:** Extract `PlacesModule` and its validation/provider calls.
- [ ] **Step 4:** Move generation-specific queue lifecycle and recovery out of generic trip CRUD only where the current code has clear boundaries; preserve existing BullMQ behavior.
- [ ] **Step 5:** Keep `core/` pure and add import-boundary checks if practical.
- [x] **Step 6:** Introduce the initial membership schema/services in a separate migration after selecting Stripe web checkout; finish entitlements, reconciliation and lifecycle policy before launch.
- [ ] **Step 7:** Revisit `users/`, `health/` and `analytics/` only when their responsibilities justify separate modules.

Each step should build, type-check and pass tests before the next one begins. Do not combine this refactor with a billing-provider migration or a wholesale database rewrite.

## 5. Membership product proposal

Suggested price hypotheses in CAD: **$5.99/month** or **$39.99/year**, with a possible limited early-adopter offer of **$29.99/year**. Validate willingness to pay, taxes, store/payment fees, support costs and retention before committing.

| Capability | Free | Travlio Pro |
|---|---|---|
| Basic route and itinerary | Included | Included |
| AI trip generation | Limited monthly allowance | Higher allowance with fair-use cap |
| Saved trips | Basic allowance | Higher allowance |
| Regenerate/revise itinerary | Limited | Higher allowance |
| Advanced features | Only currently implemented features | Add only after implementation and tests |
| Ads/sponsored placements | May appear, clearly labelled | No display ads/sponsored placements |
| Export/offline access | Only if available today | Potential benefit after implementation |

Do not promise unlimited AI generation until real usage distributions and worst-case costs are known. Example type shape only; choose actual limits through product decisions and load/cost testing.

\`\`\`ts
export type PlanCode = 'free' | 'pro_monthly' | 'pro_annual';

export interface PlanEntitlements {
  planCode: PlanCode;
  monthlyTripGenerations: number;
  maxTripDays: number;
  maxSavedTrips: number;
  maxRegenerationsPerTrip: number;
  adsEnabled: boolean;
  exportEnabled: boolean;
  offlineAccessEnabled: boolean;
}
\`\`\`

Server-side access flow:
1. Resolve authenticated user from trusted auth context.
2. Load effective subscription and entitlements.
3. Verify status and billing period.
4. Atomically reserve quota before enqueueing expensive work.
5. If enqueue fails, release the reservation or flag it for reconciliation.
6. Finalize usage against a stable generation ID.
7. Apply documented quota-refund rules; keep retries idempotent.
8. Log the decision without logging secrets or unnecessary personal data.

A client-supplied plan or isPro flag must never grant access.

## 6. Membership data model

Adapt to the repository ORM/database.

### Plans
- id, unique code (free/pro_monthly/pro_annual), name
- billing interval (month/year/none), currency (CAD), price in integer minor units
- active flag, entitlements, created/updated timestamps

### Subscriptions
- id, user_id foreign key, plan_code, provider
- provider_customer_id, unique provider_subscription_id when present
- normalized status, current period start/end
- cancel-at-period-end, cancelled-at, optional trial/grace-period end
- created/updated timestamps

Suggested statuses: none, trialing, active, past_due, cancel_pending, cancelled, expired, incomplete, refunded. Map provider states to internal states; not every provider supports every status.

### Billing webhook events
- provider and unique provider_event_id
- event type, received/processed timestamps, processing status, attempt count
- sanitized last error code; optional payload hash
- Verify signatures against required raw body, deduplicate event IDs and process idempotently. Avoid storing unnecessary sensitive payloads.

### Usage periods and events
- Usage-period aggregate: user, period start/end, metric, included limit, reserved count, consumed count, updated time.
- Usage-event ledger: user, generation/idempotency key, metric, quantity, status (reserved/consumed/released/adjusted), created time.
- Add unique constraints to prevent duplicate usage charges. Use transactions/conditional updates or atomic Redis operations with durable reconciliation. Redis alone should not be the sole durable quota record.

An optional billing-customers table can map users to provider customer IDs; enforce uniqueness per provider/customer.

## 7. Proposed membership API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /membership/me | Current plan, status, period dates, cancellation state and entitlements |
| GET | /membership/plans | Public active plan catalog |
| GET | /membership/usage | Current quota, consumed/reserved amounts and reset date |
| POST | /membership/checkout | Create checkout; server selects an allow-listed product/price |
| POST | /membership/portal | Create billing-management session if supported |
| POST | /membership/cancel | Request cancellation through provider |
| POST | /membership/webhooks/:provider | Receive and verify billing events |

Security:
- Authenticate user-specific routes.
- Never trust client-supplied price, amount, entitlement or subscription status.
- Verify webhook signatures and deduplicate event IDs.
- Keep billing secrets server-side and do not return raw provider payloads.
- Rate-limit checkout/portal creation; protect cookie sessions against CSRF.
- Use idempotency keys where supported.

## 8. Subscription lifecycle rules

- Checkout started: incomplete; no Pro access just for opening checkout.
- Payment confirmed: grant entitlements only after authoritative confirmation.
- Renewal: advance period and reset quota according to product rules.
- Payment failure: past-due where appropriate; apply documented grace period.
- Cancellation at period end: retain access until confirmed period end.
- Immediate cancellation/expiration: remove access at provider-confirmed effective time.
- Refund/chargeback: reconcile access according to documented policy.
- Duplicate/out-of-order event: idempotent processing; do not regress newer state due to old events.
- Webhook outage: periodically reconcile against provider state.

A successful checkout redirect is not proof of payment. Verified events or authoritative provider API state are the source of truth.

## 9. Billing provider decision

The initial purchase surface is web checkout using Stripe. Matching monthly and annual recurring prices are configured with Stripe price IDs, while amounts and currency come from Stripe's price API. Before launch, confirm merchant eligibility, taxes, receipts and applicable consumer-protection requirements. Native iOS/Android digital subscriptions remain out of scope; confirm current store policies and the Expo distribution model before adding native billing or cross-platform reconciliation.

## 10. Testing checklist

### Input and authorization
- [ ] Invalid dates, leap days, end-before-start, timezone and DST boundaries.
- [ ] Duration/stop count at limit, one above and missing values.
- [ ] User A cannot access User B's private trip or attach it to feedback.
- [ ] Share links enforce visibility, revocation and expiry.
- [ ] Spoofed forwarded IP headers cannot bypass throttling.

### Jobs, quotas and provider failures
- [ ] Concurrent requests cannot overspend quota.
- [ ] Queue enqueue failure does not leave a permanent queued generation.
- [ ] Worker crash/deployment interruption is recovered.
- [ ] Duplicate jobs/retries do not duplicate output or charges.
- [ ] Provider timeout, rate limit, malformed response and partial failure are handled.
- [ ] Usage reconciles against provider/model telemetry.

### Membership and billing
- [ ] Free users cannot unlock Pro by changing client state.
- [ ] Checkout alone does not grant Pro.
- [ ] Valid webhook activates the correct plan; invalid signature is rejected.
- [ ] Duplicate events are processed once; out-of-order events do not regress state.
- [ ] Cancellation-at-period-end preserves access until confirmed end.
- [ ] Payment failure, grace period, refund and chargeback follow policy.
- [ ] Quota reservation is atomic/idempotent; failed enqueue releases/reconciles it.
- [ ] Reconciliation repairs missed events; server catalog determines price/currency.

## 11. Observability and operations

Track API latency/errors; auth failures and throttles; queue depth/age and generation failures; Google operation counts and relevant SKU fields; Bedrock model ID/token usage/latency/estimated cost; cost per completed trip; subscription states, webhook failures, payment failures, conversion, cancellations and quota denials.

Correlate logs with request/generation IDs. Redact tokens, verification codes, billing data, secrets and unnecessary personal information. Alert on stuck jobs, cost spikes, webhook failures and provider outages.

## 12. Definition of done for paid launch

- [ ] P0/P1 security and data-integrity risks resolved or mitigated.
- [ ] Critical API and worker flows have regression tests.
- [ ] Generation transitions and quota reservations are atomic/idempotent.
- [ ] Stuck-job recovery and provider timeout behavior are tested.
- [ ] Google/AI usage is observable and reconciled with billing.
- [ ] Production config validation prevents unsafe defaults.
- [ ] Entitlements are enforced server-side.
- [ ] Webhooks are verified, idempotent and recoverable.
- [ ] Renewal, cancellation, failed payment, refund and quota-reset behavior is documented/tested.
- [ ] Privacy, retention, deletion, backup and recovery are documented.
- [ ] Marketing matches implemented features; toll estimates, export and offline access are not advertised before implementation.

## 13. Suggested pull-request sequence

1. **PR 1 — Validation/security:** DTO/date/duration validation, ownership checks, trusted proxy setup, production config and shared rate limits.
2. **PR 2 — Generation reliability:** state machine, atomic quota reservation, idempotency, enqueue-failure handling and stale-job recovery.
3. **PR 3 — Modular structure:** split catch-all files and isolate trips, generation, places, feedback, health and provider adapters.
4. **PR 4 — Cost instrumentation:** complete provider metering, model/token usage, generation correlation and alerts.
5. **PR 5 — Membership schema/read APIs:** plans, subscriptions, entitlements and usage; defer checkout until lifecycle tests pass.
6. **PR 6 — Billing integration:** provider adapter, checkout/portal, verified webhooks, reconciliation and lifecycle tests.
7. **PR 7 — Client membership UX:** pricing, upgrade, plan/usage display and manage/cancel flow.

**Implementation principle:** fix security and correctness first, refactor in small tested steps, then add billing. Avoid combining a large restructure, database migration and billing launch into one unreviewable change.
