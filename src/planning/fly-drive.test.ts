import { describe, expect, it } from 'vitest';
import { TripRequest, type WeatherObservation } from '../core/index.js';
import { FlightsProvider } from '../providers/flights.js';
import { GeocodingProvider, PlacesProvider, RoutesProvider } from '../providers/google.js';
import { FuelPriceProvider } from '../providers/costs-data.js';
import { Ontario511Provider } from '../providers/open-data.js';
import { nearestAirports } from '../providers/airports.js';
import type { Providers } from '../providers/providers.module.js';
import { TripPlanner } from './planner.js';
import { landmass, travelOptions } from './travel-options.js';

const providers = {
  geocoding: new GeocodingProvider(),
  routes: new RoutesProvider(),
  places: new PlacesProvider(),
  weather: { observe: async (_p: unknown, date: string, place: string): Promise<WeatherObservation> => ({ date, place, kind: 'unavailable', alerts: [] }) },
  roads: new Ontario511Provider(),
  advisories: { forCountries: async () => [] },
  fuel: new FuelPriceProvider(),
  llm: { enabled: false, complete: async () => '' },
  flights: new FlightsProvider(),
} as unknown as Providers;

const q = (destination: string, extra: object = {}) => ({
  origin: { address: 'Toronto, ON' },
  destination: { address: destination },
  startDate: '2026-10-17',
  endDate: '2026-10-21',
  roundTrip: true,
  travellers: 2,
  maxDrivingHoursPerDay: 6,
  ...extra,
});

describe('airports and continents', () => {
  it('finds the main airport for a city', () => {
    expect(nearestAirports({ lat: 43.6532, lng: -79.3832 })[0].iata).toBe('YYZ');
    expect(nearestAirports({ lat: 51.0447, lng: -114.0719 })[0].iata).toBe('YYC');
  });
  it('knows there is no road across the Atlantic', () => {
    expect(landmass({ lat: 43.65, lng: -79.38 })).toBe('north_america');
    expect(landmass({ lat: 48.85, lng: 2.35 })).toBe('afro_eurasia');
  });
});

describe('travelOptions', () => {
  it('Toronto → Calgary: drivable but long, so it suggests fly + drive with flights both ways', async () => {
    const o = await travelOptions(q('Calgary, AB'), providers);
    expect(o.drive.possible).toBe(true);
    expect(o.drive.daysEachWay).toBeGreaterThan(3);
    expect(o.recommendation).toBe('fly_drive');
    expect(o.outbound.length).toBeGreaterThan(2);
    expect(o.return.length).toBeGreaterThan(2);
    const f = o.outbound[0];
    expect([f.from.iata, f.to.iata]).toEqual(['YYZ', 'YYC']);
    expect(f.travellers).toBe(2);
    // ~4 h flight, two time zones west: the local arrival is ~2 h after departure.
    expect(f.durationMinutes).toBeGreaterThan(200);
    expect(f.durationMinutes).toBeLessThan(260);
    expect(o.sampleFlights).toBe(true);
  });

  it('Toronto → Paris: no road, so fly + drive only', async () => {
    const o = await travelOptions(q('Paris'), providers);
    expect(o.drive.possible).toBe(false);
    expect(o.recommendation).toBe('fly_drive');
    expect(o.toAirports[0].iata).toBe('CDG');
    expect(o.outbound[0].arriveLocal.slice(0, 10) >= '2026-10-17').toBe(true);
  });

  it('Toronto → Ottawa: just drive, no flights', async () => {
    const o = await travelOptions(q('Ottawa, ON'), providers);
    expect(o.recommendation).toBe('drive');
    expect(o.outbound).toEqual([]);
  });
});

describe('fly + drive planning', () => {
  it('starts the road trip at the arrival airport after landing, with flight and rental costs', async () => {
    const o = await travelOptions(q('Calgary, AB', { waypoints: [] }), providers);
    const outbound = o.outbound.find((f) => f.departLocal.endsWith('09:30'))!;
    const ret = o.return.find((f) => f.departLocal.endsWith('17:40'))!;
    const req = TripRequest.parse({
      ...q('Calgary, AB'),
      waypoints: [{ address: 'Banff, AB' }],
      travel: { mode: 'fly_drive', travellers: 2, outbound, return: ret },
    });
    const plan = await new TripPlanner(providers, { usdToCad: 1.38 }).generate(req);
    expect(plan.request.origin.address).toBe('Toronto, ON');
    expect(plan.days[0].startPlace).toContain('YYC');
    expect(plan.days[0].date).toBe('2026-10-17');
    // Lands ~11:20 local, plus an hour for bags and the car.
    expect(plan.days[0].departureTime >= '12:00').toBe(true);
    expect(plan.days.at(-1)!.endPlace).toContain('YYC');
    const costs = plan.routes.find((r) => r.id === plan.selectedRouteId)!.costs;
    expect(costs.filter((c) => c.category === 'flight')).toHaveLength(2);
    expect(costs.find((c) => c.category === 'rental')!.typical).toBe(70 * 5);
    expect(plan.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['FLY_DRIVE_ARRIVAL', 'FLY_DRIVE_RETURN']));
  });

  it('plans Paris on the ground from CDG', async () => {
    const o = await travelOptions(q('Paris', { roundTrip: false }), providers);
    const req = TripRequest.parse({ ...q('Paris', { roundTrip: false }), travel: { mode: 'fly_drive', travellers: 2, outbound: o.outbound[1] } });
    const plan = await new TripPlanner(providers, { usdToCad: 1.38 }).generate(req);
    expect(plan.days[0].startPlace).toContain('CDG');
    expect(plan.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['DRIVING_ABROAD', 'OUTSIDE_NORTH_AMERICA']));
  });
});
