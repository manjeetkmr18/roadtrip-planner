import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeocodingProvider, PlacesProvider, RoutesProvider, toOpeningPeriods } from './google.js';
import { ProviderContext } from './infra.js';
import { TollGuruProvider } from './costs-data.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, capture?: (url: string, init: RequestInit) => void) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      capture?.(url, init);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

describe('Google Routes adapter', () => {
  it('parses distance, steps, polylines and toll prices, and requests tolls', async () => {
    let sent: { url: string; body: Record<string, unknown>; mask: string } | undefined;
    stubFetch(
      {
        routes: [
          {
            distanceMeters: 450000,
            duration: '16200s',
            polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' },
            travelAdvisory: { tollInfo: { estimatedPrice: [{ currencyCode: 'USD', units: '12', nanos: 500000000 }] } },
            legs: [
              {
                steps: [
                  {
                    distanceMeters: 30000,
                    staticDuration: '1200s',
                    polyline: { encodedPolyline: '_p~iF~ps|U' },
                    startLocation: { latLng: { latitude: 43.8, longitude: -79.6 } },
                    endLocation: { latLng: { latitude: 43.85, longitude: -79.4 } },
                    navigationInstruction: { instructions: 'Take ON-407 ETR' },
                  },
                ],
              },
            ],
          },
          { distanceMeters: 470000, duration: '17000s', polyline: { encodedPolyline: '' }, legs: [] },
        ],
      },
      (url, init) => {
        sent = { url, body: JSON.parse(String(init.body)), mask: new Headers(init.headers).get('X-Goog-FieldMask') ?? '' };
      },
    );
    const ctx = new ProviderContext();
    const routes = await new RoutesProvider('k').compute(
      { origin: { lat: 43.6, lng: -79.6 }, destination: { lat: 45.4, lng: -75.7 }, waypoints: [], departureIso: '2099-01-01T08:00:00-05:00', alternatives: true, tollPasses: [], fuelType: 'hybrid' },
      ctx,
    );
    expect(sent!.body.extraComputations).toEqual(['TOLLS']);
    expect((sent!.body.routeModifiers as { vehicleInfo: { emissionType: string } }).vehicleInfo.emissionType).toBe('HYBRID');
    expect(sent!.mask).toContain('routes.travelAdvisory.tollInfo');
    expect(routes).toHaveLength(2);
    expect(routes[0].durationSeconds).toBe(16200);
    expect(routes[0].toll).toEqual({ known: true, prices: [{ currency: 'USD', amount: 12.5 }] });
    expect(routes[0].steps[0]).toMatchObject({ durationSeconds: 1200, instruction: 'Take ON-407 ETR', startLocation: { lat: 43.8, lng: -79.6 } });
    expect(routes[1].toll).toBeNull();
    expect(ctx.calls.routesWithTolls).toBe(1);
    expect(ctx.costUsd).toBeGreaterThan(0);
  });
});

describe('Google Places adapter', () => {
  it('converts opening periods, including 24-hour and past-midnight places', () => {
    expect(toOpeningPeriods([{ open: { day: 0, hour: 0, minute: 0 } }])).toHaveLength(7);
    expect(toOpeningPeriods([{ open: { day: 5, hour: 18, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } }])).toEqual([{ day: 5, open: '18:00', close: '02:00' }]);
    expect(toOpeningPeriods(undefined)).toBeUndefined();
  });
  it('searches along a route polyline and maps fields', async () => {
    let body: Record<string, unknown> = {};
    stubFetch(
      {
        places: [
          {
            id: 'ChIJ123',
            displayName: { text: 'Sandbanks Provincial Park' },
            location: { latitude: 43.9, longitude: -77.2 },
            rating: 4.7,
            userRatingCount: 12000,
            types: ['park', 'tourist_attraction'],
            googleMapsUri: 'https://maps.google.com/?cid=1',
            regularOpeningHours: { periods: [{ open: { day: 3, hour: 8, minute: 0 }, close: { day: 3, hour: 20, minute: 0 } }] },
          },
        ],
      },
      (_url, init) => (body = JSON.parse(String(init.body))),
    );
    const ctx = new ProviderContext();
    const res = await new PlacesProvider('k').alongRoute('scenic nature park', 'abc', 10, ctx);
    expect(body.searchAlongRouteParameters).toEqual({ polyline: { encodedPolyline: 'abc' } });
    expect(res[0]).toMatchObject({ id: 'ChIJ123', name: 'Sandbanks Provincial Park', ratingCount: 12000, openingHours: [{ day: 3, open: '08:00', close: '20:00' }], sample: false });
    expect(ctx.calls.placesTextSearchEnterprise).toBe(1);
  });
});

describe('Google Geocoding adapter', () => {
  it('extracts locality, province and country', async () => {
    stubFetch({
      status: 'OK',
      results: [
        {
          formatted_address: 'Mississauga, ON, Canada',
          place_id: 'p1',
          geometry: { location: { lat: 43.589, lng: -79.644 } },
          address_components: [
            { long_name: 'Mississauga', short_name: 'Mississauga', types: ['locality'] },
            { long_name: 'Ontario', short_name: 'ON', types: ['administrative_area_level_1'] },
            { long_name: 'Canada', short_name: 'CA', types: ['country'] },
          ],
        },
      ],
    });
    const r = await new GeocodingProvider('k').resolve({ address: 'Mississauga' }, new ProviderContext());
    expect(r).toMatchObject({ label: 'Mississauga, ON', country: 'CA', region: 'ON', placeId: 'p1' });
  });
  it('falls back to the sample gazetteer without a key, and says so', async () => {
    const ctx = new ProviderContext();
    const r = await new GeocodingProvider().resolve({ address: 'Calgary, AB' }, ctx);
    expect(r.region).toBe('AB');
    expect(ctx.usedSampleData).toBe(true);
  });
});

describe('TollGuru adapter', () => {
  it('maps cost fields and treats false as unavailable', async () => {
    let headers = new Headers();
    stubFetch(
      {
        summary: { currency: 'CAD' },
        routes: [{ summary: { hasTolls: true, distance: { value: 100000 }, duration: { value: 4000 } }, costs: { tag: 20.5, cash: false, licensePlate: 27, minimumTollCost: 20.5, maximumTollCost: 27 } }],
      },
      (_u, init) => (headers = new Headers(init.headers)),
    );
    const [r] = await new TollGuruProvider('secret').routes({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, [], '2026-10-14T08:00:00-04:00', new ProviderContext());
    expect(headers.get('x-api-key')).toBe('secret');
    expect(r).toMatchObject({ currency: 'CAD', tag: 20.5, cash: null, licensePlate: 27, max: 27 });
  });
});
