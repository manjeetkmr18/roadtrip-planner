import { FlightsProvider } from '../providers/flights.js';
import { describe, expect, it } from 'vitest';
import { encodePolyline, TripRequest, type RouteStep, type WeatherObservation } from '../core/index.js';
import { legCostLines } from './route-costs.js';
import { TripPlanner, localIso } from './planner.js';
import { interestQueries, rankCandidates, chooseStops } from './stops.js';
import { ProviderContext } from '../providers/infra.js';
import { GeocodingProvider, PlacesProvider, RoutesProvider, type RawRoute } from '../providers/google.js';
import { FuelPriceProvider } from '../providers/costs-data.js';
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
    llm: noLlm,
    flights: new FlightsProvider(),
    ...over,
  } as unknown as Providers;
}

describe('legCostLines', () => {
  const place = (label: string, lat: number, lng: number, country = 'CA') => ({ label, location: { lat, lng }, country, region: country === 'CA' ? 'ON' : 'NY' });
  const raw: RawRoute = { distanceMeters: 100_000, durationSeconds: 4000, polyline: '', steps: [], sample: false };
  const base = { idPrefix: 'fastest-out', labelPrefix: '', date: '2026-10-14', from: place('Toronto, ON', 43.65, -79.38), to: place('Buffalo, NY', 42.88, -78.87, 'US'), raw };

  it('prices a leg by its fuel only: no tolls', async () => {
    const lines = await legCostLines(base, req, providers(), new ProviderContext(), 1.4);
    expect(lines.map((l) => l.category)).toEqual(['fuel']);
    expect(lines[0].assumptions.join(' ')).toMatch(/border/);
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
class DryWeather {
  async observe(_p: unknown, date: string, place: string): Promise<WeatherObservation> {
    return { date, place, kind: 'forecast', precipChancePct: 10, snow: false, alerts: [], highC: 15, lowC: 6 };
  }
}

function spying(weather: unknown = new DryWeather()) {
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
  return { routeQueries, placeQueries, p: providers({ routes: new SpyRoutes(), places: new SpyPlaces(), weather }) };
}

describe('TripPlanner: Google calls per plan (cost)', () => {
  it('makes one Places search per day, taking turns between interests', async () => {
    const s = spying();
    const two = TripRequest.parse({ ...req, preferences: { interests: ['food discovery', 'history'] } });
    await new TripPlanner(s.p, { usdToCad: 1.38 }).generate(two);
    expect(s.placeQueries).toEqual(['famous local restaurant', 'historic site', 'famous local restaurant']);
  });

  it('adds an indoor search on a rainy day when the interests found nothing indoors', async () => {
    const s = spying(new FakeWeather()); // 70% rain every day
    const nature = TripRequest.parse({ ...req, preferences: { interests: ['nature'] } });
    await new TripPlanner(s.p, { usdToCad: 1.38 }).generate(nature);
    expect(s.placeQueries.filter((q) => q === 'indoor attractions')).toHaveLength(3);
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
    expect(sel.costs.some((c) => c.category === 'toll' || c.category === 'etr407')).toBe(false);
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

describe('Mockup features: days, creator mode, detours, ferries', () => {
  it('gives every day a title and sunrise/sunset, and creator tips only in creator mode', async () => {
    const plain = await new TripPlanner(providers(), { usdToCad: 1.38 }).generate(req);
    expect(plain.days.every((d) => d.title && /^\d\d:\d\d$/.test(d.sunset ?? ''))).toBe(true);
    expect(plain.days[0].title).toBe('On to Ottawa');
    expect(plain.days.some((d) => d.creatorTip)).toBe(false);
    const creator = TripRequest.parse({ ...req, preferences: { creatorMode: true } });
    const plan = await new TripPlanner(providers(), { usdToCad: 1.38 }).generate(creator);
    expect(plan.days.every((d) => d.creatorTip?.includes('Park before filming.'))).toBe(true);
    expect(plan.days[0].creatorTip).toContain(`Sunset ${plan.days[0].sunset}`);
  });

  it('passes "avoid ferries" to the route request', async () => {
    const seen: (boolean | undefined)[] = [];
    class R extends RoutesProvider {
      override async compute(q: Parameters<RoutesProvider['compute']>[0], ctx: ProviderContext) {
        seen.push(q.avoidFerries);
        return super.compute(q, ctx);
      }
    }
    await new TripPlanner(providers({ routes: new R() }), { usdToCad: 1.38 }).generate(TripRequest.parse({ ...req, preferences: { avoidFerries: true } }));
    expect(seen.every((x) => x === true)).toBe(true);
  });

  it('drops stops beyond the maximum detour', () => {
    const line = [{ lat: 44, lng: -79 }, { lat: 44, lng: -78 }];
    const near = { id: 'a', name: 'Near', location: { lat: 44.01, lng: -78.5 }, rating: 4.5, ratingCount: 900, types: [], query: 'museum', sample: false };
    const far = { ...near, id: 'b', name: 'Far', location: { lat: 44.3, lng: -78.5 } };
    expect(rankCandidates([near, far], line, 90).map((r) => r.place.id)).toEqual(['a', 'b']);
    expect(rankCandidates([near, far], line, 20).map((r) => r.place.id)).toEqual(['a']);
  });
});

describe('weather-aware stops', () => {
  const cand = (name: string, types: string[], score: number) => ({ place: { id: name, name, types, location: { lat: 0, lng: 0 } } as never, score, routeFraction: 0.5, detourMinutes: 0 });
  it('moves indoor places up on a wet day and outdoor places up on a fine day', async () => {
    const { adjustForWeather, weatherMood } = await import('./stops.js');
    const list = [cand('Riverside Park', ['park'], 10), cand('City Museum', ['museum'], 9)];
    const wet = weatherMood([{ date: '2026-10-20', place: 'x', kind: 'forecast', precipChancePct: 80, alerts: [] }]);
    expect(wet).toBe('wet');
    expect(adjustForWeather(list, wet)[0].place.name).toBe('City Museum');
    expect(adjustForWeather(list, 'fine')[0].place.name).toBe('Riverside Park');
    expect(weatherMood([{ date: '2026-10-20', place: 'x', kind: 'climate', highC: 12, alerts: [] }])).toBe('unknown');
  });
});
