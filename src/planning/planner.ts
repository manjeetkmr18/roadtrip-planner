import {
  sunTimesLocal,
  addDays,
  daysBetween,
  decodePolyline,
  DEFAULT_VISIT_MINUTES,
  distanceToRoute,
  drivingDaysNeeded,
  encodePolyline,
  fractionAlong,
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
import { timeZoneAt } from '../core/timezone.js';
import { legCostLines, parkingLine } from './route-costs.js';
import { flyDriveCosts, flyDriveIssues, roadTripFor } from './fly-drive.js';
import type { PlannerNote } from '../trips/notes.service.js';
import { adjustForWeather, chooseStops, interestQueries, placeSetting, rankCandidates, toStop, weatherMood, type DayChoiceInput } from './stops.js';

function timeZoneFor(p: ResolvedPlace): string {
  return timeZoneAt(p);
}

/** ISO timestamp with the correct UTC offset for a local date + time in a time zone. */
export function localIso(date: string, hhmm: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const localParts = (instant: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
    };
  };
  const offsets = new Set(
    [-36, -12, 0, 12, 36].map((hours) => {
      const instant = target + hours * 60 * 60_000;
      const local = localParts(instant);
      return Math.round((Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - instant) / 60_000);
    }),
  );
  const candidates = [...offsets]
    .map((offset) => ({ offset, instant: target - offset * 60_000 }))
    .filter(({ instant }) => {
      const local = localParts(instant);
      return local.year === year && local.month === month && local.day === day && local.hour === hour && local.minute === minute && local.second === 0;
    })
    .sort((a, b) => a.instant - b.instant);
  const selected = candidates[0];
  if (!selected) throw new RangeError(`Local time ${date} ${hhmm} does not exist in ${timeZone} because of a daylight-saving transition`);
  const sign = selected.offset >= 0 ? '+' : '-';
  const absolute = Math.abs(selected.offset);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  return `${date}T${hhmm}:00${offset}`;
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
}

export interface PlannerOptions {
  /** CAD per USD, or a function that looks up the current rate (read once per plan). */
  usdToCad: number | (() => Promise<number>);
  /**
   * Google Places searches per trip day (each is a billed Text Search Enterprise call).
   * With 1, the traveller's interests take turns across the days. Default 1.
   */
  placesSearchesPerDay?: number;
}

/** Results asked for per Places search. Google bills per request, not per result, so ask for the maximum. */
const PLACES_RESULTS_PER_SEARCH = 20;

/** Creator-mode tip when the model is off: sunset time plus the best photo stop of the day. */
function templateCreatorTip(endPlace: string, sunset: string | undefined, stops: Stop[]): string {
  const town = endPlace.replace(/^near /, '').split(',')[0];
  const photo = stops.find((s) => s.tags?.some((t) => ['Viewpoint', 'Nature', 'Beach', 'Hiking'].includes(t)));
  const parts = [sunset ? `Sunset ${sunset} at ${town}.` : `Golden hour near ${town}.`];
  if (photo) parts.push(`${photo.name} is the best photo stop today.`);
  parts.push('Park before filming.');
  return parts.join(' ');
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
      avoidFerries: req.preferences.avoidFerries,
    };
    const routes = await this.providers.routes.compute({ ...base, alternatives: true }, ctx);
    if (!routes.length) throw new Error(`No driving route found from ${from.label} to ${to.label}`);
    const [fastest, alternative] = routes;
    return { fastest, alternative };
  }

  /** `notes`: the traveller's own plans (trip notes marked "include in plan"); stops are chosen around them. */
  async generate(input: TripRequest, ctx = new ProviderContext(), opts: { notes?: PlannerNote[] } = {}): Promise<TripPlan> {
    const started = nowIso();
    // Fly + drive: plan the road trip on the ground, from the arrival airport.
    const road = roadTripFor(input);
    const req = road.req;
    const p = this.providers;
    const usdToCad = typeof this.opts.usdToCad === 'number' ? this.opts.usdToCad : await this.opts.usdToCad();

    // 1. Places
    const [origin, destination, ...waypoints] = await Promise.all(
      [req.origin, req.destination, ...req.waypoints].map((x, i) =>
        i === 0 && road.resolvedOrigin ? road.resolvedOrigin : i === 1 && road.resolvedDestination ? road.resolvedDestination : p.geocoding.resolve(x, ctx),
      ),
    );
    const tz = timeZoneFor(origin);
    const firstDeparture = road.firstDayDeparture ?? req.departureTime;
    const departureIso = localIso(req.startDate, firstDeparture, tz);
    const totalDays = daysBetween(req.startDate, req.endDate) + 1;
    const travelLines = flyDriveCosts(input, totalDays, usdToCad);

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
    ];
    const options: RouteOption[] = [];
    const legLinesByKind = new Map<RouteKind, CostLine[]>();
    for (const k of kinds) {
      if (!k.outRoute) continue;
      const lines = await legCostLines(
        { date: req.startDate, idPrefix: `${k.kind}-out`, labelPrefix: req.roundTrip ? 'Outbound: ' : '', raw: k.outRoute, from: origin, to: destination },
        req,
        p,
        ctx,
        usdToCad,
      );
      if (k.retRoute) {
        lines.push(
          ...(await legCostLines(
            { date: req.endDate, idPrefix: `${k.kind}-ret`, labelPrefix: 'Return: ', raw: k.retRoute, from: destination, to: origin },
            req,
            p,
            ctx,
            usdToCad,
          )),
        );
      }
      legLinesByKind.set(k.kind, lines);
      const distance = k.outRoute.distanceMeters + (k.retRoute?.distanceMeters ?? 0);
      const duration = k.outRoute.durationSeconds + (k.retRoute?.durationSeconds ?? 0);
      const allLines = [
        ...lines,
        ...(req.preferences.includeParking ? [parkingLine({ urbanStops: totalDays, otherStops: totalDays, overnights: nights, currency: req.currency })] : []),
        ...travelLines,
      ];
      options.push({
        id: k.kind,
        kind: k.kind,
        label: k.label,
        distanceMeters: distance,
        durationSeconds: duration,
        polyline: k.outRoute.polyline,
        costs: allLines,
        summary: summarizeCosts(allLines, req.currency),
        source: k.outRoute.sample
          ? { name: 'Sample route geometry', retrievedAt: nowIso() }
          : { name: 'Google Routes API', url: 'https://developers.google.com/maps/documentation/routes', retrievedAt: nowIso() },
      });
    }
    // Drop an alternative that is the same road as the fastest one.
    const fastestOpt = options.find((o) => o.kind === 'fastest');
    const filtered = options.filter((o) => o.kind === 'fastest' || !fastestOpt || Math.abs(o.distanceMeters - fastestOpt.distanceMeters) > 500);
    const selected = filtered.find((o) => o.kind === 'fastest')!;
    const selOut = out.fastest;
    const selRet = ret?.fastest;

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
    // Fly + drive: the first day starts after landing and picking up the car.
    if (road.firstDayDeparture && drafts[0]) drafts[0].day.departureTime = road.firstDayDeparture;
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

    // Stops the traveller added go on the driving day that passes closest to them, on each leg
    // (the route runs through them both ways).
    const addedStops = new Map<number, Stop[]>();
    const placeAddedStops = (legDrafts: Draft[]) => {
      waypoints.forEach((w, k) => {
        let best: { d: Draft; meters: number } | undefined;
        for (const d of legDrafts) {
          if (!d.line?.length) continue;
          const meters = distanceToRoute(d.line, w.location);
          if (!best || meters < best.meters) best = { d, meters };
        }
        if (!best || best.meters > 50_000) return;
        const list = addedStops.get(best.d.day.day) ?? [];
        list.push({
          id: `waypoint-${k + 1}-day-${best.d.day.day}`,
          name: w.label,
          kind: 'waypoint',
          location: w.location,
          visitMinutes: DEFAULT_VISIT_MINUTES.waypoint,
          routeFraction: Math.round(fractionAlong(best.d.line!, w.location) * 1000) / 1000,
          detourMinutes: 0,
          description: 'A stop you added',
        });
        addedStops.set(best.d.day.day, list);
      });
    };
    placeAddedStops(drafts.slice(0, outSegs.length));
    if (selRet) placeAddedStops(drafts.slice(drafts.length - retSegs.length));

    // 5. Weather first (it informs stop choice), then candidate stops
    // Each day's weather: where it starts, en route, where it ends, and at stops the traveller added.
    const weatherFor = async (d: Draft): Promise<WeatherObservation[]> => {
      const pts = d.line ? samplePoints(d.line, 3) : [d.endResolved.location];
      const labels = d.line ? [d.day.startPlace, `en route (${d.day.startPlace} → ${d.day.endPlace})`, d.day.endPlace] : [d.day.endPlace];
      for (const s of (addedStops.get(d.day.day) ?? []).slice(0, 2)) {
        pts.splice(pts.length - 1, 0, s.location);
        labels.splice(labels.length - 1, 0, s.name);
      }
      return Promise.all(pts.map((pt, i) => p.weather.observe(pt, d.day.date, labels[i])));
    };
    const weather = await mapLimit(drafts, 3, (d) => weatherFor(d).catch(() => [] as WeatherObservation[]));

    // Sunrise and sunset at each day's end place, in that place's time zone.
    const sun = drafts.map((d) => {
      const at = d.day.endLocation ?? d.endResolved.location;
      return sunTimesLocal(d.day.date, at.lat, at.lng, timeZoneFor(d.endResolved));
    });

    // Interests take turns across the days, so a 3-day trip with two interests still covers both
    // while making one Places search per day instead of one per interest per day.
    // Creator mode makes sure viewpoints are among the searches.
    const interests = req.preferences.creatorMode ? [...req.preferences.interests, 'photography'] : req.preferences.interests;
    const pool = interestQueries(interests, 4);
    const perDay = Math.max(1, Math.min(pool.length, this.opts.placesSearchesPerDay ?? 1));
    const searched = new Map<string, Promise<CandidatePlace[]>>();
    const searchOnce = (key: string, run: () => Promise<CandidatePlace[]>) => {
      if (!searched.has(key)) searched.set(key, run());
      return searched.get(key)!;
    };
    const dayInputs: DayChoiceInput[] = await mapLimit(drafts, 3, async (d, i) => {
      const cands: CandidatePlace[] = [];
      const queries = Array.from({ length: perDay }, (_, k) => pool[(i * perDay + k) % pool.length]);
      for (const q of queries) {
        try {
          const found = d.line
            ? await searchOnce(`route|${q}|${d.day.day}`, () => p.places.alongRoute(q, encodePolyline(d.line!), PLACES_RESULTS_PER_SEARCH, ctx))
            : await searchOnce(`near|${q}|${d.endResolved.location.lat.toFixed(2)},${d.endResolved.location.lng.toFixed(2)}`, () =>
                p.places.near(q, d.endResolved.location, 25_000, PLACES_RESULTS_PER_SEARCH, ctx),
              );
          cands.push(...found);
        } catch (e) {
          ctx.note(`Place search failed for day ${d.day.day}: ${(e as Error).message.slice(0, 100)}`);
        }
      }
      // Rainy-day backup: if the weather is wet and the searches found almost nothing indoors, look for indoor places too.
      const mood = weatherMood(weather[i]);
      if (mood === 'wet' && cands.filter((c) => placeSetting(c.types, c.name) === 'indoor').length < 2) {
        try {
          const q = 'indoor attractions';
          const found = d.line
            ? await searchOnce(`route|${q}|${d.day.day}`, () => p.places.alongRoute(q, encodePolyline(d.line!), PLACES_RESULTS_PER_SEARCH, ctx))
            : await searchOnce(`near|${q}|${d.endResolved.location.lat.toFixed(2)},${d.endResolved.location.lng.toFixed(2)}`, () =>
                p.places.near(q, d.endResolved.location, 25_000, PLACES_RESULTS_PER_SEARCH, ctx),
              );
          cands.push(...found);
        } catch (e) {
          ctx.note(`Indoor place search failed for day ${d.day.day}: ${(e as Error).message.slice(0, 100)}`);
        }
      }
      const prelimReview = reviewDay({ date: d.day.date, observations: weather[i], hasOutdoorStops: true, drivingHours: d.day.drivingSeconds / 3600 });
      const added = addedStops.get(d.day.day) ?? [];
      return {
        day: d.day.day,
        date: d.day.date,
        from: d.day.startPlace,
        to: d.day.endPlace,
        drivingHours: d.day.drivingSeconds / 3600,
        // The traveller's own stops take time from the day's budget.
        budget: Math.max(0, stopBudget(d.line ? d.day.drivingSeconds : 0, req.preferences.pace) - added.length),
        via: added.map((s) => s.name),
        weatherHeadline: prelimReview.headline,
        weather: {
          mood,
          places: weather[i]
            .filter((o) => o.kind !== 'unavailable')
            .map((o) => ({
              place: o.place,
              kind: o.kind === 'climate' ? ('typical' as const) : ('forecast' as const),
              summary: o.summary,
              highC: o.highC,
              lowC: o.lowC,
              rainChancePct: o.precipChancePct,
              snow: o.snow,
              windKmh: o.gustKmh ?? o.windKmh,
            })),
        },
        sunset: sun[i]?.sunset,
        candidates: adjustForWeather(rankCandidates(cands, d.line, req.preferences.maxDetourMinutes), mood),
      };
    });
    // A place should appear on only one day.
    const used = new Set<string>();
    for (const di of dayInputs) {
      di.candidates = di.candidates.filter((c) => !used.has(c.place.id));
      di.candidates.slice(0, di.budget).forEach((c) => used.add(c.place.id));
    }

    // The traveller's own plans for a day take time: leave room by planning one stop fewer per note (keep at least one).
    const notes = opts.notes ?? [];
    for (const di of dayInputs) {
      di.travellerNotes = notes.filter((n) => n.day === di.day);
      if (di.travellerNotes.length) di.budget = Math.max(1, di.budget - di.travellerNotes.length);
    }

    // 6. AI arranges stops from the candidates; code schedules and checks them
    const choices = await chooseStops(dayInputs, {
      tripNotes: notes.filter((n) => n.day == null),
      interests: req.preferences.interests,
      pace: req.preferences.pace,
      llm: p.llm,
      provider: ctx,
      creatorMode: req.preferences.creatorMode,
      personalInstructions: req.preferences.personalInstructions,
    });
    const days: DayPlan[] = drafts.map((d, i) => {
      const input = dayInputs[i];
      const choice = choices.get(d.day.day);
      const chosen = (choice?.ids ?? []).map((id) => input.candidates.find((c) => c.place.id === id)!).filter(Boolean);
      let stops: Stop[] = [...(addedStops.get(d.day.day) ?? []), ...chosen.map((c) => toStop(c, !d.line))];
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
      const day: DayPlan = {
        ...d.day,
        stops,
        narrative: choice?.narrative,
        title: choice?.title,
        sunrise: sun[i]?.sunrise,
        sunset: sun[i]?.sunset,
        creatorTip: req.preferences.creatorMode ? (choice?.creatorTip ?? templateCreatorTip(d.day.endPlace, sun[i]?.sunset, stops)) : undefined,
      };
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
      const attractionStops = days.flatMap((d) => d.stops.filter((s) => s.kind === 'attraction' || s.kind === 'waypoint'));
      const urbanDays = drafts.filter((d) => d.endResolved.urban).length;
      const park = parkingLine({ urbanStops: Math.min(urbanDays, attractionStops.length), otherStops: Math.max(0, attractionStops.length - urbanDays), overnights: nights, currency: req.currency });
      const lines = [...(legLinesByKind.get(selected.kind) ?? []), park, ...travelLines];
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
    issues.push(...flyDriveIssues(input, days));
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
      request: input,
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
