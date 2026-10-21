# Travlio — Backend API

NestJS API that plans road trips anywhere (with the richest live data for Canada and the US): routes, an itemised **low / typical / high** trip cost (fuel or charging, parking, and flights + rental car for fly + drive), a weather review for every driving day, realistic driving days, and stops checked against opening hours.

The clients are separate repos that talk to this API over HTTP: the website **[travlio](https://github.com/manjeetkmr18/travlio)** (Next.js) and the iOS/Android app **[travlio-app](https://github.com/manjeetkmr18/travlio-app)** (Expo).

## Stack

NestJS 12 (ESM) · PostgreSQL 16 + PostGIS (Drizzle ORM) · Redis + BullMQ (background trip generation) · Amazon Bedrock · Node 22+, npm

## Run it locally

```bash
npm install
cp .env.example .env          # add your keys (all optional; see below)
npm run infra:up              # Postgres+PostGIS and Redis via Docker
npm run build
npm run db:migrate
npm run dev                   # http://localhost:4000/api
```

Check it: `curl localhost:4000/api/health` shows which integrations are live.

Smoke test (register → create trip → generate → print the plan):

```bash
npm run smoke
# or: bash scripts/smoke.sh "Mississauga, ON" "Ottawa, ON" 2026-10-20 2026-10-22
```

**No keys yet?** It still runs end to end.
- Routes and stops use clearly labelled **sample data**.
- Weather, alerts and travel advisories are **live** (free government APIs).
- Set `QUEUE_INLINE=true` to run without Redis.

## Folder layout

```
src/
  core/        Trip logic, no I/O, fully unit-tested
               cost scenarios, fuel, weather review,
               day splitting, scheduling, feasibility checks, types
  providers/   External APIs
               Google (geocoding, routes, places), Duffel flights, Bedrock,
               Environment Canada + NWS weather, Ontario 511, travel advisories, fuel prices
  planning/    The trip planner that ties it together (planner.ts), cost lines per route, stop selection
  trips/       Trips API, BullMQ queue + worker, sharing
               Trip stops expose an on-demand Google Places photo metadata URL
  auth/        Register / login (JWT)
  users/       Authenticated profile APIs
  membership/  Stripe checkout, billing portal and subscription state
  db/          Drizzle schema + migration runner (migrations in /drizzle)
  feedback/    Feedback endpoint and module
  places/      Place autocomplete/details endpoint and module
  health/      Health and integration-check endpoints
  main.ts      App entry
```

## How a plan is made

1. **Find the places.** Geocode the origin, destination and any stops (Google).
2. **Get the routes.** The fastest route and an alternative (Google Routes). Round trips also get a return leg.
3. **Cost each route.** Fuel or charging and parking are estimated; fly + drive adds the flights and a rental car.
   Travlio doesn't price tolls: travellers plan the route they want, so tolls aren't part of the plan.
   Unknown amounts are listed, never counted as $0.
4. **Split into driving days.** Days are even and stay within the user's daily limit; overnight areas are named.
5. **Check the weather for each day**, where the day starts, en route, at stops you added and where it ends:
   - Canada and the US: Environment Canada / the US National Weather Service, with official alerts.
   - Anywhere else, or 7–9 days out: MET Norway's worldwide forecast (yr.no, CC BY 4.0).
   - Further ahead: typical weather for that week from NASA POWER's 25-year averages, labelled "typical", never "forecast".
   Each day is rated favourable / mixed / poor, with suggestions. On wet, cold or hot days indoor places rank higher
   (with an extra indoor search if nothing indoor was found), and the AI is told to plan around each place's weather.
6. **Find stops.** Search for places along the route (Google Places), then rank them.
7. **Arrange the days.** Bedrock picks and describes stops, but only from the list it was given. Without Bedrock, the ranking is used as-is.
8. **Run the checks in code.** Driving hours, opening hours, stop order, day length, late arrival, trip length, border crossing, road closures (Ontario 511) and travel advisories.

### Fly + drive

For long trips, `POST /api/trips/travel-options` says whether the trip can be driven (and in how many days),
recommends **drive** or **fly + drive**, and lists flights from the nearest airports for the dates
(Duffel, or sample flights without a key). Toronto → Paris has no road; Toronto → Calgary is 6+ days each way.

When the traveller picks flights (`TripRequest.travel`), the road trip starts at the arrival airport an hour
after landing (90 minutes after an international flight) and ends at the return flight's airport. The cost
report adds the flights and a rental-car estimate, and the checks warn if the last day runs past check-in time.
Travlio does not book flights; each flight links to the same search on Google Flights.

## API keys (`.env`)

| Variable | Used for | Notes |
|---|---|---|
| `TRUSTED_PROXY_CIDRS` | Client IP extraction when deployed behind a proxy | Optional comma-separated IPs/CIDRs for controlled proxies only. Unset means forwarded headers are not trusted; configure the actual proxy ranges before relying on IP rate limits. |
| `GOOGLE_MAPS_API_KEY` | Geocoding, Routes, Places (New), including the place-field suggestions (`GET /api/places/autocomplete`) | Server key: API restrictions only (Vercel has no fixed IPs). Never a website/referrer-restricted key; Google rejects those from servers |
| `DUFFEL_ACCESS_TOKEN` | Real flights for fly + drive | Optional; searching is free. Without it, flights are sample data |
| `EMAIL_FROM` (+ `SES_REGION` or `AWS_REGION`) | Sign-up verification codes and password resets via Amazon SES, e.g. `Travlio <no-reply@travlio.app>` | Uses the AWS credentials. Required for production startup; locally, emails are printed in the API log |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_ANNUAL`, `WEB_APP_URL` | Stripe web subscriptions | Configure all values together; use Stripe test-mode keys/prices locally. Webhook endpoint: `POST /api/membership/webhook`; subscribe it to `checkout.session.completed` and `customer.subscription.created`, `.updated`, `.deleted`. Production `WEB_APP_URL` must use HTTPS |
| `AWS_REGION`, `BEDROCK_MODEL_ID` + AWS credentials | Stop choice and day descriptions | Model must be enabled in Bedrock |
| `ONTARIO_511_API_KEY` | Road closures | Free key from 511on.ca |
| `OILPRICEAPI_KEY`, `EIA_API_KEY` | Current fuel prices (Canada / US) | Free tiers; otherwise labelled defaults |

Weather (Environment Canada, NWS, MET Norway, NASA POWER) and travel advisories (Global Affairs Canada) need no keys. `NWS_USER_AGENT` (an app name and contact email) is sent to NWS and MET Norway, which both ask for it.

### Things to verify with your accounts

- **Google pricing:** the cost meter in `src/providers/infra.ts` uses list prices: Compute Routes Essentials $5/1k (no toll prices are requested; check whether alternative routes bill as Pro on your account), Places Text Search Enterprise (rating + opening hours) $35/1k. It ignores free monthly allowances and volume discounts, so it reads high. Confirm in your billing console.

## Accounts: email verification and password reset

- Resetting a password signs the account out on every other device (`users.sessions_valid_after`, `drizzle/0007_session_invalidation.sql`). Deleted accounts are signed out straight away.
- Sign-up emails a 6-digit code (valid 30 min). Trips (`/api/trips/*`) answer `403 EMAIL_NOT_VERIFIED` until it's entered (`POST /api/auth/verify-email`). Accounts made before this existed count as verified.
- `POST /api/auth/forgot-password` emails a reset code (15 min); `POST /api/auth/reset-password` takes email + code + new password. The reply is the same whether or not the email has an account.
- Codes are stored hashed, die after 5 wrong tries, and a new one can be sent once a minute.
- The database changes (`users.email_verified_at`, `auth_codes`) are in `drizzle/0001_email_codes.sql` and are also applied automatically on first use.

**Amazon SES setup (one time):**
1. SES console (same region as `AWS_REGION`, or set `SES_REGION`) → **Identities → Create identity → Domain** `travlio.app`. Add the 3 DKIM CNAME records it shows to your DNS, and wait until it says *Verified*.
2. **Account dashboard → Request production access** (new accounts can only send to verified addresses until approved).
3. Give the `travlio.app` IAM user `ses:SendEmail` (and `ses:GetAccount` for the health check).
4. Set `EMAIL_FROM=Travlio <no-reply@travlio.app>` on the Vercel project and redeploy.

## Running costs per trip plan

What one typical plan (3-day round trip, one added stop) asks for:

| Call | SKU | Per plan |
|---|---|---|
| Find places | Geocoding | ~3 |
| Routes, main + alternative in one request (out + back) | Compute Routes (no toll prices) | 2 |
| Stops along each day | Places Text Search **Enterprise** | 1 per day (`PLACES_SEARCHES_PER_DAY`) |
| Choose stops + write day descriptions | Bedrock, `BEDROCK_FAST_MODEL_ID` if set | 1 call, ~2k tokens in, ~250 out |

How it is kept down:
- One route request per leg returns both the main route and an alternative, without toll prices (which would move it to the Enterprise SKU).
- One Places search per day; the traveller's interests take turns across days. Each search asks for 20 results (billed per request, not per result), and repeated searches in one plan are reused.
- The model sees the top 8 candidates per day, and stop choice runs on the fast model when `BEDROCK_FAST_MODEL_ID` is set.

## Checking a deployment

```bash
# End-to-end: sign up, plan a trip, share it, privacy and auth checks, then clean up.
API=https://api.travlio.app/api npm run check:api
# Add the docs login to also run the live integrations check.
API=https://api.travlio.app/api DOCS_USERNAME=... DOCS_PASSWORD=... npm run check:api
```

`GET /api/health/integrations` (behind the docs login) makes one small real call to each outside service and
reports `ok`, `fail` (with the reason) or `off` (not configured): database tables, Redis queue, Google Geocoding /
Routes / Places, Bedrock, Environment Canada, NWS, MET Norway, NASA POWER, fuel prices, Ontario 511, travel
advisories, Duffel and the Bank of Canada rate. Each run costs a few cents of Google and Bedrock usage.
The end-to-end check leaves two `check-…@example.com` accounts and one feedback row behind; it deletes its trip.

## Endpoints

```
POST /api/auth/register   POST /api/auth/login   GET /api/auth/me
GET | PATCH /api/users/me
GET /api/membership/plans   GET /api/membership/me   GET /api/membership/usage
POST /api/membership/checkout   POST /api/membership/portal
POST /api/membership/store/sync   POST /api/membership/store/webhook   (App Store / Google Play via RevenueCat)
DELETE /api/users/me   (delete the account; cancels a web subscription first)
GET | POST /api/trips/:id/notes   PATCH | DELETE /api/trips/:id/notes/:noteId   (your own notes on a trip)
GET  /api/trips           POST /api/trips        GET | PUT | DELETE /api/trips/:id
GET  /api/places/photo?placeId=<place-id>   (short-lived image URL + author attribution)
POST /api/trips/:id/generate     (plan or refresh)       GET /api/trips/usage
POST | DELETE /api/trips/:id/share   GET /api/share/:token   (public, read-only)
GET  /api/trips/saved-stops/nearby?lat=&lng=&radiusKm=   (PostGIS)
POST /api/feedback               GET /api/health
```

Membership checkout accepts `{"plan":"monthly","idempotencyKey":"<uuid>"}` (`annual` is also supported). Pro access is granted only after a verified Stripe webhook updates server-side subscription state; a checkout redirect alone does not grant access. Configure matching monthly/yearly recurring Stripe prices and webhook events before enabling payments. Pricing/upgrade UI is not part of this API repository.

### Trip notes

Travellers can add their own notes to a trip: for the whole trip or one day, optionally with a time ("13:00") and a
place, e.g. "Lunch with Priya in Kingston". Notes are stored apart from the plan (`trip_notes`), so replanning never
loses them, and they're private (not in shared links).

- Notes with "include in plan" (the default) go to the stop-choosing model on the next plan or refresh: a day with notes
  gets one stop fewer per note so there's room, and the model prefers stops near a note's place and may mention it.
  Notes don't add places to the route; add a stop to the trip for that.
- The trip assistant sees all notes, so it can answer "what did I plan for day 3?".
- Up to 50 notes per trip, 500 characters each; a note's day must be within the trip's dates. The table is created on
  first use and by `drizzle/0009_trip_notes.sql`.

### App Store and Google Play subscriptions (RevenueCat)

The iOS and Android apps sell Pro with in-app purchases through [RevenueCat](https://www.revenuecat.com). Pro from
any source (Stripe on the web, the App Store, Google Play, a complimentary grant, or the admin role) unlocks the same
features everywhere; `src/membership/entitlements.ts` is the one place that decides it.

- The app signs in to RevenueCat with the Travlio user ID (`Purchases.logIn(user.id)`), so purchases belong to the account.
- After a purchase or restore the app calls `POST /api/membership/store/sync`; RevenueCat's webhook
  (`POST /api/membership/store/webhook`) keeps renewals, cancellations, refunds and billing issues up to date.
- Both re-read the customer from RevenueCat's REST API (`GET /v1/subscribers/{id}`) and store the result in
  `store_subscriptions`. The webhook body is only used to know which account to re-read, so a forged event grants nothing.
- Sandbox (TestFlight / test track) purchases count, so App Review can test Pro; `store_subscriptions.sandbox` marks them.
- The table is created on first use; `drizzle/0008_store_subscriptions.sql` is safe to run afterwards.

Setup:
1. RevenueCat: create the project, add the iOS and Android apps, create the entitlement `pro` and attach the monthly
   and annual products from App Store Connect and Google Play Console to it; put them in the `default` offering.
2. RevenueCat → Integrations → Webhooks: URL `https://api.travlio.app/api/membership/store/webhook`, Authorization
   header value = a long random string.
3. Vercel: set `REVENUECAT_SECRET_KEY` (secret API key) and `REVENUECAT_WEBHOOK_AUTH` (the same random string).
4. The app needs its public SDK keys (`EXPO_PUBLIC_REVENUECAT_IOS_KEY`, `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY`); see the app's README.

For the step-by-step Stripe test/live setup and remaining paid-launch work, see [the paid launch checklist](./docs/PAID_LAUNCH_CHECKLIST.md).

Generated stops expose `photosUrl` when Google Places is configured. The client should request that URL when rendering a stop card; it returns a temporary Google-hosted image URL and any photo-author attributions. Display the author attribution and Google Maps attribution with the image. The photo reference and temporary image URL are resolved on demand rather than stored in trip plans.

For the client implementation contract, loading/error behavior, accessibility, attribution, and UI test cases, see [Trip Place Images — Client UI Integration](./docs/PLACE_IMAGES_UI_INTEGRATION.md).

The late-arrival lodging adjustment is available in the web and mobile trip screens. It previews a route to nearby lodging, updates the arrival day and subsequent destination-day start, and supports undo. See [Late-arrival itinerary adjustments](./docs/ITINERARY_ADJUSTMENTS.md) for the API contract, migration, and MVP boundaries.

### API docs (password protected)

Interactive docs (Swagger UI) are at **`/api/docs`**, and the OpenAPI spec at `/api/docs-json` (or `/api/docs-yaml`). For example: `https://api.travlio.app/api/docs`.

- They are behind a username and password (HTTP Basic auth). Set `DOCS_USERNAME` and `DOCS_PASSWORD` (12+ characters). **If either is missing, the docs aren't served at all**, so a deployment never exposes them by accident.
- To try the signed-in endpoints from the docs: call `POST /api/auth/login`, copy the `token`, click **Authorize** and paste it.
- Request bodies in the docs come from the same validators the API uses, so they stay in step with the code.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API with auto-reload |
| `npm run build` / `npm start` | Production build / run |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | TypeScript check |
| `npm run db:generate` | New migration after changing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (enables PostGIS) |
| `npm run smoke` | End-to-end test against a running API |

## Production notes

- Set a strong `JWT_SECRET`; the app refuses to start in production without one.
- Set `WEB_ORIGIN` to the web app's URL. It controls CORS for browsers; separate several URLs with commas. The iOS and Android apps don't need it.
- Phones reach the API over your network, so in development the API must be reachable from the phone (same Wi-Fi). It already listens on all network interfaces.
- The BullMQ worker runs inside the API process. Add more instances to scale.
- Rate limits are counted in memory per instance. On Vercel the client address comes from `x-vercel-forwarded-for` (set by Vercel); elsewhere set `TRUSTED_PROXY_CIDRS` for your proxies.
- Shared links (`/api/share/:token`) show the plan without the owner's private assistant notes, provider notes or API spend. `DELETE /api/trips/:id/share` turns a link off.

### Hosting on Vercel (api.travlio.app) with Neon

Vercel detects NestJS and runs the API as a function. Set these in the Vercel project → Settings → Environment Variables (Production):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's **pooled** connection string (host contains `-pooler`), with `?sslmode=require` |
| `JWT_SECRET` | 32+ random characters (`openssl rand -base64 32`) |
| `WEB_ORIGIN` | `https://travlio.app,https://www.travlio.app` |
| `DOCS_USERNAME`, `DOCS_PASSWORD` | To turn on `/api/docs` |
| `NWS_USER_AGENT` | `travlio (you@yourdomain)` |
| API keys | `GOOGLE_MAPS_API_KEY`, `AWS_REGION` + `BEDROCK_MODEL_ID` (+ AWS keys), etc. |

On Vercel the app automatically plans trips in-process (no Redis or worker needed) and keeps the database pool small. It refuses to start with a missing `JWT_SECRET` or a localhost `DATABASE_URL`, so a misconfigured deploy fails loudly.

Create the tables once on Neon from your computer (uses the direct, non-pooled URL):

```bash
DATABASE_URL="postgres://…neon.tech/neondb?sslmode=require" npm run db:migrate
```

Neon's free plan is fine to start; upgrade when traffic grows. To use a separate worker later, set `REDIS_URL` (e.g. Upstash) and `QUEUE_INLINE=false` and run the worker on a host that stays up.
