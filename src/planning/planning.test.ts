import { describe, expect, it } from 'vitest';
import { encodePolyline, TripRequest, type RouteStep, type WeatherObservation } from '../core/index.js';
import { find407, legCostLines } from './route-costs.js';
import { TripPlanner, localIso } from './planner.js';
import { interestQueries, rankCandidates, chooseStops } from './stops.js';
import { ProviderContext } from '../providers/infra.js';
import { GeocodingProvider, PlacesProvider, RoutesProvider, type RawRoute } from '../providers/google.js';
import { FuelPriceProvider, TollGuruProvider, type TollGuruRoute } from '../providers/costs-data.js';
import { AdvisoryProvider, Ontario511Provider } from '../providers/open-data.js';
import type { Providers } from '../providers/providers.module.js';
import type { Llm } from '../providers/llm.js';

const req = TripRequest.parse({
  origin: { address: 'Mississauga, ON' },
  destination: { address: 'Ottawa, ON' },
  startDate: '2026-10-14',
  endDate: '2026-10-16',
  roundTrip: true,
});

class FakeWeather {
  async observe(_p: unknown, date: string, place: string): Promise<WeatherObservation> {
    return { date, place, kind: 'forecast', precipChancePct: 70, snow: false, alerts: [], highC: 12, lowC: 4 };
  }
}
class FakeAdvisories {
  async forCountries(c: string[]) {
    return c.includes('US') ? [{ countryCode: 'US', country: 'United States', level: 0, text: 'Exercise normal security precautions', updatedAt: '2026-10-10', url: 'https://travel.gc.ca/destinations/united-states', issuedBy: 'GAC' }] : [];
  }
}
class FakeTollGuru extends TollGuruProvider {
  constructor(private readonly result: TollGuruRoute[]) {
    super('test-key');
  }
  override async routes(): Promise<TollGuruRoute[]> {
    return this.result;
  }
}
const noLlm: Llm = { enabled: false, complete: async () => '' };

function providers(over: Partial<Record<keyof Providers, unknown>> = {}): Providers {
  return {
    geocoding: new GeocodingProvider(),
    routes: new RoutesProvider(),
    places: new PlacesProvider(),
    weather: new FakeWeather(),
    roads: new Ontario511Provider(),
    advisories: new FakeAdvisories(),
    fuel: new FuelPriceProvider(),
    tollguru: new TollGuruProvider(),
    llm: noLlm,
    ...over,
  } as unknown as Providers;
}

describe('find407', () => {
  it('splits a step that crosses Brock Road into ETR and provincial kilometres', () => {
    const step: RouteStep = {
      distanceMeters: 40_000,
      durationSeconds: 1500,
      instruction: 'Continue onto ON-407 E',
      polyline: encodePolyline([
        { lat: 43.86, lng: -79.3 },
        { lat: 43.87, lng: -79.09 },
        { lat: 43.9, lng: -78.85 },
      ]),
      roads: [],
    };
    const r = find407([{ distanceMeters: 5000, durationSeconds: 300, instruction: 'Head north', roads: [] }, step]);
    expect(r.etrKm).toBeGreaterThan(15);
    expect(r.provincial407Km).toBeGreaterThan(15);
    expect(r.etrKm + r.provincial407Km).toBeCloseTo(40, 5);
    expect(r.etrTrips).toBe(1);
    expect(r.etrEntryOffsetSeconds).toBe(300);
  });
  it('ignores routes without the 407', () => {
    expect(find407([{ distanceMeters: 1000, durationSeconds: 60, instruction: 'Merge onto ON-401 E', roads: [] }]).etrKm).toBe(0);
  });
});

describe('legCostLines', () => {
  const place = (label: string, lat: number, lng: number, country = 'CA') => ({ label, location: { lat, lng }, country, region: country === 'CA' ? 'ON' : 'NY' });
  const raw = (toll: RawRoute['toll'], steps: RouteStep[] = []): RawRoute => ({
    distanceMeters: 100_000,
    durationSeconds: 4000,
    polyline: '',
    steps,
    toll,
    sample: false,
  });
  const base = {
    idPrefix: 'fastest-out',
    labelPrefix: '',
    date: '2026-10-14',
    departureMinutes: 7 * 60,
    departureIso: '2026-10-14T07:00:00-04:00',
    from: place('Toronto, ON', 43.65, -79.38),
    to: place('Buffalo, NY', 42.88, -78.87, 'US'),
    waypoints: [],
    useTollGuru: false,
  };

  it('converts Google USD tolls to CAD and keeps unknown tolls unknown', async () => {
    const ctx = new ProviderContext();
    const lines = await legCostLines({ ...base, raw: raw({ known: true, prices: [{ currency: 'USD', amount: 5 }] }) }, req, providers(), ctx, 1.4);
    const toll = lines.find((l) => l.category === 'toll')!;
    expect(toll.currency).toBe('CAD');
    expect(toll.typical).toBe(7);
    const unknown = await legCostLines({ ...base, raw: raw({ known: false, prices: [] }) }, req, providers(), ctx, 1.4);
    expect(unknown.find((l) => l.category === 'toll')!.typical).toBeNull();
    const fuel = lines.find((l) => l.category === 'fuel')!;
    expect(fuel.assumptions.join(' ')).toMatch(/border/);
  });

  it('lets a matching TollGuru route replace Google and 407 toll lines (no double counting)', async () => {
    const steps: RouteStep[] = [
      { distanceMeters: 30_000, durationSeconds: 1200, instruction: 'Take ON-407', polyline: encodePolyline([{ lat: 43.8, lng: -79.6 }, { lat: 43.85, lng: -79.4 }]), roads: [] },
    ];
    const tg = new FakeTollGuru([{ distanceMeters: 102_000, durationSeconds: 4100, currency: 'CAD', tag: 20, cash: null, licensePlate: 31, min: 20, max: 31, hasTolls: true }]);
    const lines = await legCostLines({ ...base, useTollGuru: true, raw: raw({ known: false, prices: [] }, steps) }, req, providers({ tollguru: tg }), new ProviderContext(), 1.4);
    const tolls = lines.filter((l) => l.category === 'toll' || l.category === 'etr407');
    expect(tolls).toHaveLength(1);
    expect(tolls[0].label).toMatch(/TollGuru/);
    expect(tolls[0].typical).toBe(31); // no transponder → licence-plate billing
    expect(tolls[0].assumptions.join(' ')).toMatch(/Our own 407 ETR check/);
  });

  it('skips the monthly 407 account fee when told it was already counted', async () => {
    const steps: RouteStep[] = [{ distanceMeters: 30_000, durationSeconds: 1200, instruction: 'Take ON-407', polyline: encodePolyline([{ lat: 43.8, lng: -79.6 }, { lat: 43.85, lng: -79.4 }]), roads: [] }];
    const a = await legCostLines({ ...base, raw: raw(null, steps) }, req, providers(), new ProviderContext(), 1.4);
    const b = await legCostLines({ ...base, chargeEtrAccountFee: false, raw: raw(null, steps) }, req, providers(), new ProviderContext(), 1.4);
    const ea = a.find((l) => l.category === 'etr407')!;
    const eb = b.find((l) => l.category === 'etr407')!;
    expect(ea.typical! - eb.typical!).toBeCloseTo(5, 2);
  });

  it('charges nothing for Highway 407 East (toll-free since June 1, 2025)', async () => {
    const steps: RouteStep[] = [
      {
        distanceMeters: 40_000,
        durationSeconds: 1500,
        instruction: 'Continue onto ON-407 E',
        polyline: encodePolyline([{ lat: 43.86, lng: -79.3 }, { lat: 43.87, lng: -79.09 }, { lat: 43.9, lng: -78.85 }]),
        roads: [],
      },
    ];
    const lines = await legCostLines({ ...base, raw: raw(null, steps) }, req, providers(), new ProviderContext(), 1.4);
    expect(lines.filter((l) => l.typical == null)).toHaveLength(0);
    const etr = lines.find((l) => l.category === 'etr407')!;
    expect(etr.assumptions.join(' ')).toMatch(/407 East .* toll-free since June 1, 2025/);
  });
});

describe('stops', () => {
  it('maps interests to at most two queries', () => {
    expect(interestQueries(['nature', 'museums', 'food'])).toEqual(['scenic nature park', 'museum']);
    expect(interestQueries([])).toEqual(['top tourist attractions']);
  });
  it('drops obscure places and far detours, ranks by popularity', () => {
    const line = [{ lat: 45, lng: -79 }, { lat: 45, lng: -78 }];
    const r = rankCandidates(
      [
        { id: 'a', name: 'Popular', location: { lat: 45.01, lng: -78.5 }, rating: 4.7, ratingCount: 5000, types: [], query: 'q', sample: false },
        { id: 'b', name: 'Obscure', location: { lat: 45.0, lng: -78.4 }, rating: 5, ratingCount: 3, types: [], query: 'q', sample: false },
        { id: 'c', name: 'Far away', location: { lat: 46.5, lng: -78.5 }, rating: 4.9, ratingCount: 9000, types: [], query: 'q', sample: false },
      ],
      line,
    );
    expect(r.map((x) => x.place.id)).toEqual(['a']);
    expect(r[0].routeFraction).toBeGreaterThan(0.4);
  });
  it('rejects model output that names places outside the candidate list', async () => {
    const llm: Llm = { enabled: true, complete: async () => '{"days":[{"day":1,"stopIds":["invented","a"],"narrative":"Nice day."}]}' };
    const cand = { place: { id: 'a', name: 'A', location: { lat: 0, lng: 0 }, types: [], query: 'q', sample: false }, score: 1, routeFraction: 0.5, detourMinutes: 0 };
    const out = await chooseStops([{ day: 1, date: '2026-10-14', from: 'X', to: 'Y', drivingHours: 3, budget: 2, candidates: [cand] }], {
      interests: [],
      pace: 'balanced',
      llm,
      provider: new ProviderContext(),
    });
    expect(out.get(1)!.ids).toEqual(['a']);
    expect(out.get(1)!.byModel).toBe(true);
  });
});

/** Wraps the sample providers and records what the planner asks Google for. */
function spying() {
  const routeQueries: { alternatives: boolean }[] = [];
  const placeQueries: string[] = [];
  class SpyRoutes extends RoutesProvider {
    override async compute(q: Parameters<RoutesProvider['compute']>[0], ctx: ProviderContext) {
      routeQueries.push({ alternatives: q.alternatives });
      return super.compute(q, ctx);
    }
  }
  class SpyPlaces extends PlacesProvider {
    override async alongRoute(query: string, polyline: string, max: number, ctx: ProviderContext) {
      placeQueries.push(query);
      expect(max).toBe(20);
      return super.alongRoute(query, polyline, max, ctx);
    }
    override async near(query: string, center: { lat: number; lng: number }, r: number, max: number, ctx: ProviderContext) {
      placeQueries.push(query);
      return super.near(query, center, r, max, ctx);
    }
  }
  return { routeQueries, placeQueries, p: providers({ routes: new SpyRoutes(), places: new SpyPlaces() }) };
}

describe('TripPlanner: Google calls per plan (cost)', () => {
  it('makes one Places search per day, taking turns between interests', async () => {
    const s = spying();
    const two = TripRequest.parse({ ...req, preferences: { interests: ['food discovery', 'history'] } });
    await new TripPlanner(s.p, { usdToCad: 1.38 }).generate(two);
    expect(s.placeQueries).toEqual(['famous local restaurant', 'historic site', 'famous local restaurant']);
  });

  it('can still make one search per interest per day when configured', async () => {
    const s = spying();
    const two = TripRequest.parse({ ...req, preferences: { interests: ['food discovery', 'history'] } });
    await new TripPlanner(s.p, { usdToCad: 1.38, placesSearchesPerDay: 2 }).generate(two);
    expect(s.placeQueries).toHaveLength(6);
  });

  it('makes one route request per leg (main route plus alternatives)', async () => {
    const s = spying();
    await new TripPlanner(s.p, { usdToCad: 1.38 }).generate(req);
    expect(s.routeQueries).toEqual([{ alternatives: true }, { alternatives: true }]);
  });
});

describe('TripPlanner (sample mode)', () => {
  it('builds a full round-trip plan with costs, days, weather reviews and checks', async () => {
    const plan = await new TripPlanner(providers(), { usdToCad: 1.38 }).generate(req);
    expect(plan.usedSampleData).toBe(true);
    expect(plan.days).toHaveLength(3);
    expect(plan.days[0].drivingSeconds).toBeGreaterThan(0);
    expect(plan.days[1].drivingSeconds).toBe(0); // free day in Ottawa
    expect(plan.days[2].endPlace).toMatch(/Mississauga/);
    const sel = plan.routes.find((r) => r.id === plan.selectedRouteId)!;
    expect(sel.summary.low).toBeLessThanOrEqual(sel.summary.typical);
    expect(sel.summary.typical).toBeLessThanOrEqual(sel.summary.high);
    expect(sel.costs.some((c) => c.category === 'etr407')).toBe(true);
    // 407 monthly account fee counted once across the trip
    const etr = sel.costs.filter((c) => c.category === 'etr407');
    expect(etr.filter((c) => c.assumptions.join(' ').includes('monthly account fee counted on another leg')).length).toBe(etr.length - 1);
    expect(plan.days.every((d) => d.weather?.rating === 'mixed')).toBe(true);
    expect(plan.days.flatMap((d) => d.stops).every((s) => s.kind === 'overnight' || s.arrivalTime)).toBe(true);
  });

  it('flags a trip that is too short for the distance', async () => {
    const long = TripRequest.parse({ ...req, destination: { address: 'Calgary, AB' }, roundTrip: false, endDate: '2026-10-15' });
    const plan = await new TripPlanner(providers(), { usdToCad: 1.38 }).generate(long);
    const codes = plan.issues.map((i) => i.code);
    expect(codes).toContain('TRIP_TOO_SHORT');
    expect(codes).toContain('PAST_END_DATE');
    expect(plan.days.length).toBeGreaterThanOrEqual(5);
    // every driving day respects the 6 h limit (+10%)
    expect(plan.days.every((d) => d.drivingSeconds <= 6.6 * 3600)).toBe(true);
  });

  it('adds border and advisory info for US destinations', async () => {
    const us = TripRequest.parse({ ...req, destination: { address: 'New York, NY' }, roundTrip: false });
    const plan = await new TripPlanner(providers(), { usdToCad: 1.38 }).generate(us);
    expect(plan.issues.map((i) => i.code)).toContain('BORDER_CROSSING');
    expect(plan.advisories[0].country).toBe('United States');
  });

  it('puts stops the traveller added on the driving days that pass them, on both legs', async () => {
    const viaMontreal = TripRequest.parse({
      ...req,
      origin: { address: 'Toronto, ON' },
      destination: { address: 'Quebec City, QC' },
      waypoints: [{ address: 'Montreal, QC' }],
      startDate: '2026-10-14',
      endDate: '2026-10-18',
    });
    const plan = await new TripPlanner(providers(), { usdToCad: 1.38 }).generate(viaMontreal);
    const added = plan.days.flatMap((d) => d.stops.filter((s) => s.kind === 'waypoint').map((s) => ({ day: d, stop: s })));
    expect(added).toHaveLength(2); // outbound and return
    for (const { day, stop } of added) {
      expect(stop.name).toBe('Montreal, QC');
      expect(day.drivingSeconds).toBeGreaterThan(0);
      expect(stop.arrivalTime).toBeDefined();
      expect(day.narrative).toMatch(/via Montreal, QC/);
    }
    expect(added[0].day.day).toBeLessThan(added[1].day.day);
  });
});

describe('localIso', () => {
  it('applies the daylight-saving offset for the zone', () => {
    expect(localIso('2026-07-01', '08:00', 'America/Toronto')).toBe('2026-07-01T08:00:00-04:00');
    expect(localIso('2026-01-15', '08:00', 'America/Toronto')).toBe('2026-01-15T08:00:00-05:00');
    expect(localIso('2026-01-15', '08:00', 'America/Regina')).toBe('2026-01-15T08:00:00-06:00');
  });
});
