# Road Trip Planner

**Know the real cost and a doable plan before you go.** A road-trip planner for Canada and cross-border US trips that itemises every toll (including the 407 ETR, which Google can't price), fuel or charging, and parking as a **low / typical / high** range. It reviews the **weather for every driving day** and splits the drive into days that fit your limit. Code, not the AI, checks each plan for driving hours, opening hours and stop order.

Planning only: no bookings. Every number shows its source and a confidence label (verified, provider estimate, approximate, or unknown). Unknown tolls are never counted as $0.

## What's in the repo

```
apps/api        NestJS 12 API (ESM) · Postgres/PostGIS via Drizzle · BullMQ worker · provider adapters
apps/web        Next.js 16 (App Router) · Tailwind 4 · Google Maps via @vis.gl/react-google-maps
packages/core   Shared types (zod) and deterministic trip logic, fully unit-tested:
                cost scenarios, 407 ETR calculator, fuel/charging, weather review, day splitting, feasibility
scripts/smoke.sh  End-to-end test against a running API
```

### How a plan is made

1. **Places**: Google Geocoding resolves the origin, destination and stops.
2. **Routes**: Google Routes API returns the fastest route, an alternative and an avoid-tolls route, with `TOLLS` extra computation. Round trips also get the return leg.
3. **Costs, per route**:
   - **407 ETR**: our own calculator, using the operator's published 2026 rates by zone, time of entry and weekday/weekend/holiday. It includes the $1 trip charge, plus the camera charge and monthly account fee when you have no transponder. Steps are split at Brock Road, so the provincial 407 East shows separately.
   - **Other tolls**: Google's estimate. If a toll exists but has no price, it is shown as **Unknown**.
   - **TollGuru** (optional): cross-checks the fastest route. When its route matches within 8%, its all-tolls figure replaces the Google and 407 lines, so nothing is counted twice.
   - **Fuel / charging**: your consumption × distance × a regional price range, with winter and real-world multipliers.
   - **Parking**: an estimate from the number and type of stops.
   - USD amounts are converted to CAD at a configured rate, labelled approximate.
4. **Days**: the route is split into even driving days within your daily limit. A cut can fall inside a long highway step; the overnight area is then placed along that step's polyline and named by reverse geocoding. Free days go at the destination, and return days come last.
5. **Weather**: forecasts at the start, middle and end of each driving day.
   - Sources: **Environment Canada (MSC GeoMet)** in Canada and the **US National Weather Service** in the US, plus official alerts. Both are free.
   - Each day is rated *favourable / mixed / poor (per forecast)*, using the daytime forecast, with suggestions. Days outside the ~6-day forecast window say so.
6. **Stops**: Google Places text search *along the route* (or near the destination on free days). Candidates are ranked by rating × review volume minus detour.
7. **AI (Amazon Bedrock)** picks and describes stops **only from those candidates**. Output is validated: invented IDs are dropped. If Bedrock is off or fails, the deterministic ranking is used.
8. **Checks (code)**: scheduled arrival times with rest breaks, opening hours, stop order, daily driving limit, day length by pace, late arrival, trip too short, past end date, border crossing, poor-weather days, and road closures from **Ontario 511**.
9. **Advisories**: Government of Canada travel advisories (open data) for countries outside Canada.

Each generation records its estimated API spend (Google, TollGuru, model tokens at list prices) on the trip and in the `generations` table. The **free-plan limit** (`FREE_TRIPS_PER_MONTH`) is enforced per user.

## Run it locally

Requirements: Node 22+, pnpm 10, Docker (or local Postgres 16 with PostGIS, and Redis 7).

```bash
pnpm install
pnpm infra:up                         # Postgres+PostGIS and Redis via docker compose
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @rtp/core build
pnpm --filter @rtp/api build && pnpm db:migrate
pnpm dev                              # API on :4000, web on :3000
```

Open http://localhost:3000, create an account and plan a trip.

**Without any keys** the app still works end to end:
- Routes, places and stops use clearly labelled **sample data**, from a built-in list of major Canadian/US cities.
- Weather, alerts and travel advisories are **live**, since they're free public APIs.

Set `QUEUE_INLINE=true` to skip Redis during development.

Smoke test against the running API:

```bash
./scripts/smoke.sh "Mississauga, ON" "Ottawa, ON" 2026-10-20 2026-10-22
```

`GET /api/health` shows which integrations are live.

## API keys

| Variable | Where | Used for | Cost |
|---|---|---|---|
| `GOOGLE_MAPS_API_KEY` (api) | Google Cloud: enable **Geocoding API**, **Routes API**, **Places API (New)** | Places, routes, tolls, stops | Pay-as-you-go with monthly free caps per SKU |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (web) | Separate **browser** key, Maps JavaScript API, restricted by referrer | Interactive map (else an SVG sketch) | Dynamic Maps SKU |
| `TOLLGURU_API_KEY` | tollguru.com | Toll cross-check / Canada toll coverage | From $80/mo for 5,000 calls |
| `AWS_REGION`, `BEDROCK_MODEL_ID` (+ AWS credentials) | Amazon Bedrock with model access enabled | Choosing and describing stops | Per token |
| `ONTARIO_511_API_KEY` | 511on.ca developer key (free) | Road closures on Ontario highways | Free; 10 calls/min, cached 5 min |
| `OILPRICEAPI_KEY` | oilpriceapi.com | Provincial gasoline averages (Canada) | Free tier |
| `EIA_API_KEY` | eia.gov (free) | Weekly US fuel prices | Free |
| none | Environment Canada, NWS, Global Affairs Canada | Weather, alerts, advisories | Free |

Without the fuel keys, fuel prices fall back to planning defaults, which are clearly labelled.

### Things to verify with your accounts

- **Google SKUs**: requests with tolls, and Places requests with rating/opening-hours fields, bill at higher tiers. The cost meter assumes Routes $15/1k and Text Search Enterprise $35/1k (`apps/api/src/providers/infra.ts`). Confirm against your billing console.
- **Google terms**: place IDs may be stored indefinitely. Other Places content is refreshed on each generation, and Google data is shown on a Google map when the browser key is set. Review the terms before adding caching.
- **407 ETR rates** are in `packages/core/src/etr407.ts`. Update them each January, when the operator publishes new rates. The weekend chart publishes two tables, one per direction, without labels; the range covers both.
- **Bedrock model ID**: use a model or inference profile enabled in your region. Set `LLM_*_USD_PER_MTOK` to its price.

## Production notes

- The BullMQ worker runs inside the API process (`concurrency: 3`). To scale, run more API instances; they share the Redis queue.
- Set a strong `JWT_SECRET` (startup fails in production otherwise), `WEB_ORIGIN` for CORS, and `PROVIDER_MODE=auto`.
- Keep the server Google key restricted by API and server IP. Never ship it to the browser.

## API

```
POST /api/auth/register | /api/auth/login        GET /api/auth/me
GET  /api/trips          POST /api/trips          GET|PUT|DELETE /api/trips/:id
POST /api/trips/:id/generate   (queue a plan or refresh)       GET /api/trips/usage
POST /api/trips/:id/share      GET /api/share/:token (public, read-only)
GET  /api/trips/saved-stops/nearby?lat=&lng=&radiusKm=   (PostGIS)
POST /api/feedback       ("report incorrect info")          GET /api/health
```

## Tests

```bash
pnpm -r test        # core: 18 tests (407 rates, holidays, costs, weather, day splitting, feasibility)
                    # api: 18 tests (toll logic, TollGuru de-duplication, planner end to end, adapter parsing)
pnpm -r typecheck
```

## Not built yet

- Mobile apps: the API is ready for React Native.
- Climate averages for dates beyond the forecast window: currently shown as "refresh closer to departure".
- Parking data from operators. Today parking is an estimate.
- Payments for the paid plan: the free-plan limit is enforced, but there is no checkout.
- Road-closure feeds outside Ontario (other provinces and states have their own 511 APIs).
