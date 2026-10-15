# Travlio — Backend API

NestJS API that plans Canada / cross-border road trips: routes, an itemised **low / typical / high** trip cost (tolls, the 407 ETR, fuel or charging, parking), a weather review for every driving day, realistic driving days, and stops checked against opening hours.

The app is a separate repo: **[roadtrip-planner-app](https://github.com/manjeetkmr18/roadtrip-planner-app)**. It's a single Expo (React Native) codebase for iOS, Android and web, and it talks to this API over HTTP.

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
               407 ETR rates, cost scenarios, fuel, weather review,
               day splitting, scheduling, feasibility checks, types
  providers/   External APIs
               Google (geocoding, routes, places), TollGuru, Bedrock,
               Environment Canada + NWS weather, Ontario 511, travel advisories, fuel prices
  planning/    The trip planner that ties it together (planner.ts), cost lines per route, stop selection
  trips/       Trips API, BullMQ queue + worker, sharing
  auth/        Register / login (JWT)
  db/          Drizzle schema + migration runner (migrations in /drizzle)
  misc.ts      Feedback + health endpoints
  main.ts      App entry
```

## How a plan is made

1. **Find the places.** Geocode the origin, destination and any stops (Google).
2. **Get the routes.** Fastest, alternative and avoid-tolls routes, with toll info (Google Routes). Round trips also get a return leg.
3. **Cost each route.**
   - The **407 ETR** uses our own calculator from the published 2026 rates, since Google can't price it.
   - Other tolls come from Google.
   - **TollGuru** cross-checks tolls without double counting.
   - Fuel and parking are estimated.
   - Unknown tolls are listed, never counted as $0.
4. **Split into driving days.** Days are even and stay within the user's daily limit; overnight areas are named.
5. **Check the weather for each day.** Forecasts come from Environment Canada or the US National Weather Service, plus official alerts. Each day is rated favourable / mixed / poor, with suggestions.
6. **Find stops.** Search for places along the route (Google Places), then rank them.
7. **Arrange the days.** Bedrock picks and describes stops, but only from the list it was given. Without Bedrock, the ranking is used as-is.
8. **Run the checks in code.** Driving hours, opening hours, stop order, day length, late arrival, trip length, border crossing, road closures (Ontario 511) and travel advisories.

## API keys (`.env`)

| Variable | Used for | Notes |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | Geocoding, Routes (tolls), Places (New) | Server key, restrict by API + IP |
| `TOLLGURU_API_KEY` | Toll cross-check / Canada tolls | Optional |
| `AWS_REGION`, `BEDROCK_MODEL_ID` + AWS credentials | Stop choice and day descriptions | Model must be enabled in Bedrock |
| `ONTARIO_511_API_KEY` | Road closures | Free key from 511on.ca |
| `OILPRICEAPI_KEY`, `EIA_API_KEY` | Current fuel prices (Canada / US) | Free tiers; otherwise labelled defaults |

Weather (Environment Canada, NWS) and travel advisories (Global Affairs Canada) need no keys.

### Things to verify with your accounts

- **Google pricing:** the cost meter in `src/providers/infra.ts` uses list prices: Compute Routes Enterprise (toll prices) $15/1k, Essentials $5/1k, Places Text Search Enterprise (rating + opening hours) $35/1k. It ignores free monthly allowances and volume discounts, so it reads high. Confirm in your billing console.
- **407 ETR rates:** stored in `src/core/etr407.ts`. Update them every January.

## Running costs per trip plan

What one typical plan (3-day round trip, one added stop, tolls on the way) asks for:

| Call | SKU | Per plan |
|---|---|---|
| Find places | Geocoding | ~3 |
| Main routes, with toll prices (out + back) | Compute Routes **Enterprise** | 2 |
| Toll-free option (out + back) | Compute Routes Essentials (Enterprise if it crosses a border, for bridge tolls) | 0–2 |
| Stops along each day | Places Text Search **Enterprise** | 1 per day (`PLACES_SEARCHES_PER_DAY`) |
| Choose stops + write day descriptions | Bedrock, `BEDROCK_FAST_MODEL_ID` if set | 1 call, ~2k tokens in, ~250 out |

How it is kept down:
- Toll prices are only asked for on routes where they can change the cost; the toll-free option is a plain route.
- One Places search per day; the traveller's interests take turns across days. Each search asks for 20 results (billed per request, not per result), and repeated searches in one plan are reused.
- The model sees the top 8 candidates per day, and stop choice runs on the fast model when `BEDROCK_FAST_MODEL_ID` is set.

## Endpoints

```
POST /api/auth/register   POST /api/auth/login   GET /api/auth/me
GET  /api/trips           POST /api/trips        GET | PUT | DELETE /api/trips/:id
POST /api/trips/:id/generate     (plan or refresh)       GET /api/trips/usage
POST /api/trips/:id/share        GET /api/share/:token   (public, read-only)
GET  /api/trips/saved-stops/nearby?lat=&lng=&radiusKm=   (PostGIS)
POST /api/feedback               GET /api/health
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API with auto-reload |
| `npm run build` / `npm start` | Production build / run |
| `npm test` | 36 unit tests |
| `npm run typecheck` | TypeScript check |
| `npm run db:generate` | New migration after changing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (enables PostGIS) |
| `npm run smoke` | End-to-end test against a running API |

## Production notes

- Set a strong `JWT_SECRET`; the app refuses to start in production without one.
- Set `WEB_ORIGIN` to the web app's URL. It controls CORS for browsers; separate several URLs with commas. The iOS and Android apps don't need it.
- Phones reach the API over your network, so in development the API must be reachable from the phone (same Wi-Fi). It already listens on all network interfaces.
- The BullMQ worker runs inside the API process. Add more instances to scale.
