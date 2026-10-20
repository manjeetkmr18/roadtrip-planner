# Paid Launch and Remaining Work Checklist

Use this checklist to finish the remaining engineering and account setup before enabling paid subscriptions. The API currently supports web subscriptions through Stripe. It does not include the pricing/upgrade UI, mobile app-store billing, a finalized Pro entitlement policy, or a complete billing reconciliation process.

> **Secrets:** Never add Stripe keys, webhook secrets, database credentials, or other credentials to source control, documentation, screenshots, or support tickets. Store them in local `.env` (which must remain untracked) for development and in the hosting provider's encrypted environment-variable store for deployment.

## 1. Stripe account setup

Do these steps in Stripe **test mode** first.

- [ ] Complete Stripe account/business verification and confirm that the account can accept payments in the intended countries and currencies.
- [ ] Configure public business name, support contact, statement descriptor, customer email/receipt settings, refund policy, and required tax settings in Stripe.
- [ ] Create two active recurring Stripe prices:
  - [ ] Monthly subscription; copy its `price_...` ID.
  - [ ] Annual subscription; copy its `price_...` ID.
- [ ] Decide the actual price, currency, taxes, trials, and refund policy before publishing prices. The API reads displayed price/currency from Stripe; confirm both configured prices are the intended products.
- [ ] Add the following environment variables to local `.env` or the deployment secret store. Use test-mode credentials and price IDs for test mode, and live-mode values only for production:

  | Variable | Where to get it / value |
  |---|---|
  | `STRIPE_SECRET_KEY` | Stripe Developers → API keys; secret key for the matching test or live mode |
  | `STRIPE_WEBHOOK_SECRET` | Signing secret for the webhook endpoint created below; it is different for each endpoint/mode |
  | `STRIPE_PRICE_ID_MONTHLY` | `price_...` ID of the active monthly recurring price |
  | `STRIPE_PRICE_ID_ANNUAL` | `price_...` ID of the active annual recurring price |
  | `WEB_APP_URL` | Base URL of the web client that will host `/membership` and `/membership/success`; production must use HTTPS |

- [ ] Keep test and live variables in separate deployment environments. Do not mix a live secret key with test-mode price IDs or webhook secret.

## 2. Stripe webhook endpoint

The API endpoint is `POST https://<api-host>/api/membership/webhook`. Configure it in Stripe Developers → Webhooks for the matching mode.

- [ ] Subscribe to exactly the event types the application handles:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
- [ ] Copy that endpoint's signing secret into `STRIPE_WEBHOOK_SECRET` in the same environment as the matching API key and prices.
- [ ] Confirm the deployment preserves the raw request body for signature verification (`main.ts` enables Nest raw-body support).
- [ ] Send Stripe's test event and confirm it receives a successful response. A verified event is required for the API to update a user's plan; the checkout redirect alone does not grant Pro.
- [ ] Verify delivery attempts and application logs without logging full webhook bodies, payment data, or secrets.

## 3. Database and deployment

- [ ] Take or verify a database backup and confirm the target database/environment before applying schema changes.
- [ ] Build the API, then apply the migration using the documented procedure. For the current project scripts, `npm run db:migrate` runs the built migration runner, so build first.
- [ ] Confirm the migration runner applies `drizzle/0003_membership.sql` and that the subscription tables and `users.stripe_customer_id` exist.
- [ ] Do not apply the migration to production until the target URL, backup, and rollout window are confirmed.
- [ ] Configure all Stripe environment variables in the hosting provider's encrypted settings and redeploy.
- [ ] Confirm startup succeeds, `GET /api/membership/plans` returns both configured active prices, and authenticated `GET /api/membership/me` and `/api/membership/usage` return expected values.
- [ ] Ensure `WEB_APP_URL` points to the intended client and `WEB_ORIGIN` allows that origin for browser requests.

## 4. Test-mode subscription lifecycle

Use Stripe's test cards and test clocks/events where appropriate. Verify API state and Stripe dashboard state together.

- [ ] A verified account can create a monthly checkout session; an unverified account cannot.
- [ ] Selecting an unrecognized plan or invalid idempotency key is rejected.
- [ ] Repeating the same checkout idempotency request does not create a second customer/session; an open subscription checkout is reused or safely rejected.
- [ ] Existing subscriptions cannot be duplicated by starting another checkout.
- [ ] A completed, paid checkout followed by a valid webhook activates Pro. A redirect without a valid webhook does not.
- [ ] Monthly and annual prices map to the intended internal plan codes.
- [ ] Duplicate webhook delivery is processed idempotently.
- [ ] Invalid webhook signatures are rejected.
- [ ] Subscription update and deletion events update access correctly, including cancellation at period end.
- [ ] Exercise renewal, failed payment, unpaid/past-due, pause, cancellation, refund, and chargeback behavior. Document decisions for any state not currently represented by the API policy.
- [ ] Verify old or out-of-order events cannot overwrite newer subscription state. If this is not guaranteed, implement event ordering/reconciliation before live launch.
- [ ] Verify billing portal sessions return to the expected web page and expose only the authenticated user's Stripe customer.
- [ ] Confirm database failure during webhook handling produces a retryable non-success response, not a success-shaped response.

## 5. Product and entitlement decisions still required

- [ ] Define the plan catalog (names, prices, currency, billing interval, included features, and whether trials exist).
- [ ] Define Pro generation limits/fair-use policy. At present, Pro generation is not capped; do not advertise unlimited usage until costs and abuse risk are understood.
- [ ] Define quota period/reset behavior, concurrent-generation limits, retry accounting, and when failed jobs restore usage.
- [ ] Define access for `past_due`, `unpaid`, paused, canceled-at-period-end, refund, and chargeback states, including any grace period.
- [ ] Enforce these entitlements server-side in every applicable API. A client-supplied plan or `isPro` flag must never grant access.
- [ ] Add atomic, durable quota reservations and idempotent usage records if plan limits differ from the current free-generation counter.
- [ ] Document the customer-facing renewal, cancellation, refund, trial, tax, and support policies.
- [ ] Build and test the web pricing, upgrade, success/cancel, usage, and manage-subscription UI. The API repository currently does not provide these screens.
- [ ] Decide whether native iOS/Android subscriptions are in scope. If they are, review current store billing requirements before adding another provider path.

## 6. Remaining engineering and launch work

### Security and operations

- [ ] Confirm actual production proxy IP/CIDR ranges and configure `TRUSTED_PROXY_CIDRS`; verify the platform's proxy chain.
- [ ] Add a shared rate limiter for multi-instance deployments; current in-memory limits are not globally shared.
- [ ] Review production CORS origins, auth defaults, health/integration endpoint disclosure, and rate limits.
- [ ] Document production database backup, restore, migration rollback/recovery, privacy, retention, and account deletion procedures.

### Generation reliability and cost

- [ ] Define a bounded retry policy for transient provider failures and normalize public error responses.
- [ ] Test timeouts, rate limits, malformed provider responses, partial route/AI failures, duplicate jobs, and worker interruption.
- [ ] Instrument billable Google operations and AI model/token/latency usage by generation; reconcile estimates with provider billing.
- [ ] Add spend limits/alerts and operational alerts for provider failures, queue age, stuck jobs, and cost spikes.

### Architecture and product roadmap

- [ ] Separate generation lifecycle/recovery from trip CRUD where the boundary is clear; preserve queue behavior.
- [ ] Keep `core/` independent of NestJS, providers, and persistence; add an import-boundary check if practical.
- [ ] Add campground/camping discovery, availability/pricing assumptions, and route-proximate overnight options.
- [ ] Add hotel/resort search and nightly/total-trip budget estimates; make unknown fees explicit rather than zero.
- [ ] Validate accommodation selections against budget, route proximity, and overnight constraints.
- [ ] Consider growth metrics, affiliate recommendations, and sponsorships only after product retention is understood.

## 7. Go-live gate

- [ ] Test-mode lifecycle checklist is complete and reviewed.
- [ ] Product, entitlement, grace-period, refund, and cancellation policies are approved.
- [ ] Production migration is applied to the confirmed database with a verified backup.
- [ ] Live-mode prices, API key, webhook endpoint, and webhook secret are configured in the correct production environment.
- [ ] Production prices and customer-facing policy/website text match Stripe configuration.
- [ ] A low-risk live purchase and cancellation have been verified end to end, if appropriate for launch.
- [ ] Monitoring, support ownership, refund handling, and incident/reconciliation procedures are in place.
- [ ] No credentials are committed to Git; test and live secrets are stored separately.

## API reference

- `GET /api/membership/plans` — active configured Stripe prices.
- `GET /api/membership/me` — effective plan and latest subscription state.
- `GET /api/membership/usage` — monthly completed plus active reserved generations.
- `POST /api/membership/checkout` — authenticated checkout creation.
- `POST /api/membership/portal` — authenticated Stripe billing portal.
- `POST /api/membership/webhook` — Stripe-signed event receiver.

For implementation status and the larger engineering roadmap, see [Todo.md](../Todo.md) and [ENGINEERING_AUDIT_AND_MEMBERSHIP_PLAN.md](./ENGINEERING_AUDIT_AND_MEMBERSHIP_PLAN.md).
