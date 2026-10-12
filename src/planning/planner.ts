import {
  addDays,
  daysBetween,
  decodePolyline,
  drivingDaysNeeded,
  encodePolyline,
  parseHHMM,
  reviewDay,
  bestOutdoorDay,
  scheduleDay,
  splitIntoDrivingDays,
  stopBudget,
  summarizeCosts,
  validatePlan,
  samplePoints,
  type CostLine,
  type DriveSegment,
  type DayPlan,
  type Issue,
  type LatLng,
  type RouteKind,
  type RouteOption,
  type Stop,
  type TripPlan,
  type TripRequest,
  type WeatherObservation,
} from '../core/index.js';
import type { Providers } from '../providers/providers.module.js';
import type { RawRoute, ResolvedPlace, CandidatePlace } from '../providers/google.js';
import { nowIso, ProviderContext } from '../providers/infra.js';
import { legCostLines, parkingLine } from './route-costs.js';
import { chooseStops, interestQueries, rankCandidates, toStop, type DayChoiceInput } from './stops.js';

const REGION_TZ: Record<string, string> = {
  BC: 'America/Vancouver',
  AB: 'America/Edmonton',
  SK: 'America/Regina',
  MB: 'America/Winnipeg',
  ON: 'America/Toronto',
  QC: 'America/Toronto',
  NB: 'America/Halifax',
  NS: 'America/Halifax',
  PE: 'America/Halifax',
  NL: 'America/St_Johns',
};

function timeZoneFor(p: ResolvedPlace): string {
  if (p.region && REGION_TZ[p.region] && p.country !== 'US') return REGION_TZ[p.region];
  const lng = p.location.lng;
  if (lng > -87.5) return 'America/New_York';
  if (lng > -101) return 'America/Chicago';
  if (lng > -114) return 'America/Denver';
  return 'America/Los_Angeles';
}

/** ISO timestamp with the correct UTC offset for a local date + time in a time zone. */
export function localIso(date: string, hhmm: string, timeZone: string): string {
  const guess = new Date(`${date}T${hhmm}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(guess);
  const off = parts.find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00';
  return `${date}T${hhmm}:00${off === '' ? '+00:00' : off}`;
}

function segmentPolyline(seg: DriveSegment): LatLng[] {
  const pts: LatLng[] = [];
  for (const { step } of seg.steps) {
    const p = step.polyline ? decodePolyline(step.polyline) : [step.startLocation, step.endLocation].filter((x): x is LatLng => !!x);
    pts.push(...p);
  }
  // Keep the polyline small enough for Places "search along route".
  const stride = Math.max(1, Math.floor(pts.length / 400));
  return pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

interface LegRoutes {
  fastest: RawRoute;
  alternative?: RawRoute;
  avoidTolls?: RawRoute;
}

export interface PlannerOptions {
  usdToCad: number;
}

export class TripPlanner {
  constructor(
    private readonly providers: Providers,
    private readonly opts: PlannerOptions,
  ) {}

  private async legRoutes(from: ResolvedPlace, to: ResolvedPlace, via: ResolvedPlace[], departureIso: string, req: TripRequest, ctx: ProviderContext): Promise<LegRoutes> {
    const base = {
      origin: from.location,
      destination: to.location,
      waypoints: via.map((w) => w.location),
      departureIso,
      tollPasses: req.vehicle.tollPasses,
      fuelType: req.vehicle.fuelType,
    };
    const routes = await this.providers.routes.compute({ ...base, avoidTolls: false, alternatives: true }, ctx);
    if (!routes.length) throw new Error(`No driving route found from ${from.label} to ${to.label}`);
    const [fastest, alternative] = routes;
    const tolled = (r: RawRoute) => r.toll != null || r.steps.some((s) => s.roads.includes('407') || /\b407\b|toll/i.test(s.instruction ?? ''));
    let avoidTolls: RawRoute | undefined;
    if (tolled(fastest) || req.preferences.avoidTolls) {
      [avoidTolls] = await this.providers.routes.compute({ ...base, avoidTolls: true, alternatives: false }, ctx);
    }
    return { fastest, alternative, avoidTolls };
  }

  async generate(req: TripRequest, ctx = new ProviderContext()): Promise<TripPlan> {
    const started = nowIso();
    const p = this.providers;

    // 1. Places
    const [origin, destination, ...waypoints] = await Promise.all(
      [req.origin, req.destination, ...req.waypoints].map((x) => p.geocoding.resolve(x, ctx)),
    );
    const tz = timeZoneFor(origin);
    const departureIso = localIso(req.startDate, req.departureTime, tz);
    const departureMinutes = parseHHMM(req.departureTime);
    const totalDays = daysBetween(req.startDate, req.endDate) + 1;

    // 2. Routes (outbound + optional return)
    const out = await this.legRoutes(origin, destination, waypoints, departureIso, req, ctx);
    const ret = req.roundTrip
      ? await this.legRoutes(destination, origin, [...waypoints].reverse(), localIso(req.endDate, req.departureTime, timeZoneFor(destination)), req, ctx)
      : undefined;

    // 3. Route options with costs (round trips include the matching return leg)
    const nights = Math.max(0, totalDays - 1);
    const kinds: { kind: RouteKind; label: string; outRoute?: RawRoute; retRoute?: RawRoute }[] = [
      { kind: 'fastest', label: 'Fastest', outRoute: out.fastest, retRoute: ret?.fastest },
      { kind: 'alternative', label: 'Alternative', outRoute: out.alternative, retRoute: ret?.fastest },
      { kind: 'avoid_tolls', label: 'Avoid tolls', outRoute: out.avoidTolls, retRoute: ret?.avoidTolls ?? ret?.fastest },
    ];
    const options: RouteOption[] = [];
    const legLinesByKind = new Map<RouteKind, CostLine[]>();
    for (const k of kinds) {
      if (!k.outRoute) continue;
      const common = { date: req.startDate, departureMinutes, departureIso, useTollGuru: k.kind === 'fastest' };
      const lines = await legCostLines(
        { ...common, idPrefix: `${k.kind}-out`, labelPrefix: req.roundTrip ? 'Outbound: ' : '', raw: k.outRoute, from: origin, to: destination, waypoints },
        req,
        p,
        ctx,
        this.opts.usdToCad,
      );
      if (k.retRoute) {
        lines.push(
          ...(await legCostLines(
            {
              ...common,
              date: req.endDate,
              departureIso: localIso(req.endDate, req.departureTime, timeZoneFor(destination)),
              idPrefix: `${k.kind}-ret`,
              labelPrefix: 'Return: ',
              raw: k.retRoute,
              from: destination,
              to: origin,
              waypoints: [...waypoints].reverse(),
              chargeEtrAccountFee: !(lines.some((l) => l.category === 'etr407') && req.startDate.slice(0, 7) === req.endDate.slice(0, 7)),
            },
            req,
            p,
            ctx,
            this.opts.usdToCad,
          )),
        );
      }
      legLinesByKind.set(k.kind, lines);
      const distance = k.outRoute.distanceMeters + (k.retRoute?.distanceMeters ?? 0);
      const duration = k.outRoute.durationSeconds + (k.retRoute?.durationSeconds ?? 0);
      const allLines = req.preferences.includeParking
        ? [...lines, parkingLine({ urbanStops: totalDays, otherStops: totalDays, overnights: nights, currency: req.currency })]
        : lines;
      options.push({
        id: k.kind,
        kind: k.kind,
        label: k.label,
        distanceMeters: distance,
        durationSeconds: duration,
        polyline: k.outRoute.polyline,
        hasTolls: allLines.some((l) => l.category === 'toll' || l.category === 'etr407'),
        costs: allLines,
        summary: summarizeCosts(allLines, req.currency),
        source: k.outRoute.sample
          ? { name: 'Sample route geometry', retrievedAt: nowIso() }
          : { name: 'Google Routes API', url: 'https://developers.google.com/maps/documentation/routes', retrievedAt: nowIso() },
      });
    }
    // Drop an "avoid tolls" option identical to the fastest one.
    const fastestOpt = options.find((o) => o.kind === 'fastest');
    const filtered = options.filter(
      (o) => o.kind === 'fastest' || !fastestOpt || Math.abs(o.distanceMeters - fastestOpt.distanceMeters) > 500 || o.hasTolls !== fastestOpt.hasTolls,
    );
    const selected = (req.preferences.avoidTolls && filtered.find((o) => o.kind === 'avoid_tolls')) || filtered.find((o) => o.kind === 'fastest')!;
    const selOut = selected.kind === 'avoid_tolls' ? out.avoidTolls! : selected.kind === 'alternative' ? out.alternative! : out.fastest;
    const selRet = ret ? (selected.kind === 'avoid_tolls' ? (ret.avoidTolls ?? ret.fastest) : ret.fastest) : undefined;

    // 4. Days: outbound driving days, free days at the destination, return driving days
    const maxH = req.preferences.maxDrivingHoursPerDay;
    const outDays = drivingDaysNeeded(selOut.durationSeconds, maxH);
    const retDays = selRet ? drivingDaysNeeded(selRet.durationSeconds, maxH) : 0;
    const freeDays = Math.max(0, totalDays - outDays - retDays);
    const outSegs = splitIntoDrivingDays(selOut.steps, outDays);
    const retSegs = selRet ? splitIntoDrivingDays(selRet.steps, retDays) : [];

    type Draft = { day: DayPlan; line: LatLng[] | null; endResolved: ResolvedPlace };
    const drafts: Draft[] = [];
    let dayNo = 0;
    let prev = origin;
    const pushDriving = async (segs: DriveSegment[], finalPlace: ResolvedPlace) => {
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const end = i === segs.length - 1 ? finalPlace : await p.geocoding.reverse(seg.endLocation!, ctx);
        dayNo++;
        drafts.push({
          day: {
            day: dayNo,
            date: addDays(req.startDate, dayNo - 1),
            startPlace: prev.label,
            endPlace: end.label,
            endLocation: end.location,
            distanceMeters: seg.distanceMeters,
            drivingSeconds: seg.drivingSeconds,
            departureTime: req.departureTime,
            stops: [],
          },
          line: segmentPolyline(seg),
          endResolved: end,
        });
        prev = end;
      }
    };
    await pushDriving(outSegs, destination);
    for (let i = 0; i < freeDays; i++) {
      dayNo++;
      drafts.push({
        day: {
          day: dayNo,
          date: addDays(req.startDate, dayNo - 1),
          startPlace: destination.label,
          endPlace: destination.label,
          endLocation: destination.location,
          distanceMeters: 0,
          drivingSeconds: 0,
          departureTime: '09:30',
          stops: [],
        },
        line: null,
        endResolved: destination,
      });
    }
    if (selRet) await pushDriving(retSegs, origin);

    // 5. Weather first (it informs stop choice), then candidate stops
    const weatherFor = async (d: Draft): Promise<WeatherObservation[]> => {
      const pts = d.line ? samplePoints(d.line, 3) : [d.endResolved.location];
      const labels = d.line ? [d.day.startPlace, `en route (${d.day.startPlace} → ${d.day.endPlace})`, d.day.endPlace] : [d.day.endPlace];
      return Promise.all(pts.map((pt, i) => p.weather.observe(pt, d.day.date, labels[i])));
    };
    const weather = await mapLimit(drafts, 3, (d) => weatherFor(d).catch(() => [] as WeatherObservation[]));

    const queries = interestQueries(req.preferences.interests);
    const dayInputs: DayChoiceInput[] = await mapLimit(drafts, 3, async (d, i) => {
      const cands: CandidatePlace[] = [];
      for (const q of queries) {
        try {
          const found = d.line
            ? await p.places.alongRoute(q, encodePolyline(d.line), 10, ctx)
            : await p.places.near(q, d.endResolved.location, 25_000, 10, ctx);
          cands.push(...found);
        } catch (e) {
          ctx.note(`Place search failed for day ${d.day.day}: ${(e as Error).message.slice(0, 100)}`);
        }
      }
      const prelimReview = reviewDay({ date: d.day.date, observations: weather[i], hasOutdoorStops: true, drivingHours: d.day.drivingSeconds / 3600 });
      return {
        day: d.day.day,
        date: d.day.date,
        from: d.day.startPlace,
        to: d.day.endPlace,
        drivingHours: d.day.drivingSeconds / 3600,
        budget: d.line ? stopBudget(d.day.drivingSeconds, req.preferences.pace) : stopBudget(0, req.preferences.pace),
        weatherHeadline: prelimReview.rating === 'unknown' ? undefined : prelimReview.headline,
        candidates: rankCandidates(cands, d.line),
      };
    });
    // A place should appear on only one day.
    const used = new Set<string>();
    for (const di of dayInputs) {
      di.candidates = di.candidates.filter((c) => !used.has(c.place.id));
      di.candidates.slice(0, di.budget).forEach((c) => used.add(c.place.id));
    }

    // 6. AI arranges stops from the candidates; code schedules and checks them
    const choices = await chooseStops(dayInputs, { interests: req.preferences.interests, pace: req.preferences.pace, llm: p.llm, provider: ctx });
    const days: DayPlan[] = drafts.map((d, i) => {
      const input = dayInputs[i];
      const choice = choices.get(d.day.day);
      const chosen = (choice?.ids ?? []).map((id) => input.candidates.find((c) => c.place.id === id)!).filter(Boolean);
      let stops: Stop[] = chosen.map((c) => toStop(c, !d.line));
      if (!d.line) {
        // Free day: order stops by a simple nearest-neighbour walk from the destination centre.
        stops = stops.map((s, k) => ({ ...s, routeFraction: Math.min(1, (k + 1) / (stops.length + 1)) }));
      }
      if (d.line && d.day.day !== drafts.length) {
        stops.push({
          id: `overnight-${d.day.day}`,
          name: d.day.endPlace.startsWith('near ') ? `Overnight ${d.day.endPlace}` : `Overnight in ${d.day.endPlace}`,
          kind: 'overnight',
          location: d.day.endLocation!,
          visitMinutes: 0,
          description: 'Suggested overnight area (not a booking).',
        });
      }
      const day: DayPlan = { ...d.day, stops, narrative: choice?.narrative };
      const scheduled = scheduleDay(day);
      const hasOutdoor = scheduled.stops.some((s) => /park|trail|beach|viewpoint|natural|campground/i.test(`${s.description ?? ''} ${s.name}`));
      return {
        ...day,
        stops: scheduled.stops,
        weather: reviewDay({ date: day.date, observations: weather[i], hasOutdoorStops: hasOutdoor, drivingHours: day.drivingSeconds / 3600 }),
      };
    });

    // 7. Parking for the selected route, from the actual stops
    if (req.preferences.includeParking) {
      const attractionStops = days.flatMap((d) => d.stops.filter((s) => s.kind === 'attraction'));
      const urbanDays = drafts.filter((d) => d.endResolved.urban).length;
      const park = parkingLine({ urbanStops: Math.min(urbanDays, attractionStops.length), otherStops: Math.max(0, attractionStops.length - urbanDays), overnights: nights, currency: req.currency });
      const lines = [...(legLinesByKind.get(selected.kind) ?? []), park];
      selected.costs = lines;
      selected.summary = summarizeCosts(lines, req.currency);
    }

    // 8. Roads, advisories
    const roadEvents = (
      await Promise.all(
        [selOut, selRet]
          .filter((r): r is RawRoute => !!r && !!r.polyline)
          .map((r) => p.roads.eventsNearRoute(r.polyline, ctx).catch((e) => {
            ctx.note(`Ontario 511 unavailable: ${(e as Error).message.slice(0, 80)}`);
            return [];
          })),
      )
    ).flat();
    const countries = [origin, destination, ...waypoints].map((x) => x.country).filter((c): c is string => !!c);
    const advisories = await p.advisories.forCountries(countries).catch(() => {
      ctx.note('Travel advisories could not be loaded; check travel.gc.ca.');
      return [];
    });

    // 9. Checks
    const issues: Issue[] = validatePlan({
      days,
      preferences: req.preferences,
      totalTripDays: totalDays,
      drivingDaysNeeded: outDays + retDays,
    });
    if (new Set(countries).size > 1) {
      issues.push({
        severity: 'info',
        code: 'BORDER_CROSSING',
        message: 'This trip crosses the Canada–US border: carry a passport or NEXUS card, check entry rules, and allow time for border waits.',
      });
    }
    for (const d of days) {
      if (d.weather?.rating === 'poor') {
        issues.push({ severity: 'warning', code: 'WEATHER_POOR', day: d.day, message: `Day ${d.day}: ${d.weather.headline}` });
      }
    }
    const outdoorBest = bestOutdoorDay(days.map((d) => d.weather!).filter(Boolean));
    if (outdoorBest && days.some((d) => d.weather?.rating === 'poor')) {
      issues.push({ severity: 'info', code: 'WEATHER_BEST_DAY', message: `Best forecast day for outdoor plans: ${outdoorBest}.` });
    }
    for (const e of roadEvents.filter((r) => r.fullClosure)) {
      issues.push({ severity: 'warning', code: 'ROAD_CLOSURE', message: `${e.road}: ${e.description}` });
    }
    if (days.length && days[days.length - 1].date > req.endDate) {
      issues.push({ severity: 'error', code: 'PAST_END_DATE', message: `The plan runs to ${days[days.length - 1].date}, past your end date ${req.endDate}.` });
    }

    return {
      generatedAt: started,
      request: req,
      selectedRouteId: selected.id,
      routes: filtered,
      days,
      issues,
      roadEvents,
      advisories,
      usedSampleData: ctx.usedSampleData,
      providerNotes: [...ctx.notes],
      apiCostUsd: ctx.costUsd,
    };
  }
}
