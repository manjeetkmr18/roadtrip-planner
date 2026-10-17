# Travlio — Backend API

NestJS API that plans Canada / cross-border road trips: routes, an itemised **low / typical / high** trip cost (fuel or charging, parking, and flights + rental car for fly + drive), a weather review for every driving day, realistic driving days, and stops checked against opening hours.

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
               cost scenarios, fuel, weather review,
               day splitting, scheduling, feasibility checks, types
  providers/   External APIs
               Google (geocoding, routes, places), Duffel flights, Bedrock,
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
| `GOOGLE_MAPS_API_KEY` | Geocoding, Routes, Places (New) | Server key, restrict by API + IP |
| `DUFFEL_ACCESS_TOKEN` | Real flights for fly + drive | Optional; searching is free. Without it, flights are sample data |
| `AWS_REGION`, `BEDROCK_MODEL_ID` + AWS credentials | Stop choice and day descriptions | Model must be enabled in Bedrock |
| `ONTARIO_511_API_KEY` | Road closures | Free key from 511on.ca |
| `OILPRICEAPI_KEY`, `EIA_API_KEY` | Current fuel prices (Canada / US) | Free tiers; otherwise labelled defaults |

Weather (Environment Canada, NWS, MET Norway, NASA POWER) and travel advisories (Global Affairs Canada) need no keys. `NWS_USER_AGENT` (an app name and contact email) is sent to NWS and MET Norway, which both ask for it.

### Things to verify with your accounts

- **Google pricing:** the cost meter in `src/providers/infra.ts` uses list prices: Compute Routes Essentials $5/1k (no toll prices are requested; check whether alternative routes bill as Pro on your account), Places Text Search Enterprise (rating + opening hours) $35/1k. It ignores free monthly allowances and volume discounts, so it reads high. Confirm in your billing console.

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

## Endpoints

```
POST /api/auth/register   POST /api/auth/login   GET /api/auth/me
GET  /api/trips           POST /api/trips        GET | PUT | DELETE /api/trips/:id
POST /api/trips/:id/generate     (plan or refresh)       GET /api/trips/usage
POST /api/trips/:id/share        GET /api/share/:token   (public, read-only)
GET  /api/trips/saved-stops/nearby?lat=&lng=&radiusKm=   (PostGIS)
POST /api/feedback               GET /api/health
```

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
| `npm test` | 52 unit tests |
| `npm run typecheck` | TypeScript check |
| `npm run db:generate` | New migration after changing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (enables PostGIS) |
| `npm run smoke` | End-to-end test against a running API |

## Production notes

- Set a strong `JWT_SECRET`; the app refuses to start in production without one.
- Set `WEB_ORIGIN` to the web app's URL. It controls CORS for browsers; separate several URLs with commas. The iOS and Android apps don't need it.
- Phones reach the API over your network, so in development the API must be reachable from the phone (same Wi-Fi). It already listens on all network interfaces.
- The BullMQ worker runs inside the API process. Add more instances to scale.

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
