import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaceSearchProvider, sampleSuggestions } from './place-search.js';

afterEach(() => vi.unstubAllGlobals());

describe('place suggestions', () => {
  it('finds real lodging near the arrival area with a lodging-only Places search', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        places: [{
          id: 'ChIJhotel123456',
          displayName: { text: 'Example Hotel' },
          formattedAddress: '123 Main Street, Calgary, AB',
          location: { latitude: 51.05, longitude: -114.07 },
        }],
      })),
    );
    vi.stubGlobal('fetch', fetch);
    const suggestions = await new PlaceSearchProvider('google-key').lodging('downtown', { lat: 51.04, lng: -114.06 });

    expect(suggestions).toEqual([{
      placeId: 'ChIJhotel123456',
      title: 'Example Hotel',
      subtitle: '123 Main Street, Calgary, AB',
      address: '123 Main Street, Calgary, AB',
      location: { lat: 51.05, lng: -114.07 },
    }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(JSON.parse(init.body as string)).toMatchObject({
      textQuery: 'downtown',
      includedType: 'lodging',
      strictTypeFiltering: true,
      locationBias: { circle: { center: { latitude: 51.04, longitude: -114.06 } } },
    });
  });

  it('does not fabricate lodging options when the Google key is missing', async () => {
    await expect(new PlaceSearchProvider().lodging('', { lat: 51.04, lng: -114.06 }))
      .rejects.toThrow('Hotel search needs GOOGLE_MAPS_API_KEY');
  });

  it('suggests sample cities by prefix, with coordinates', () => {
    const s = sampleSuggestions('kin');
    expect(s[0]).toMatchObject({ title: 'Kingston', address: 'Kingston, ON' });
    expect(s[0].location).toBeDefined();
    expect(sampleSuggestions('par')[0].title).toBe('Paris');
  });

  it('calls Places Autocomplete (New) with the session and bias, and maps predictions', async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          suggestions: [
            { placePrediction: { placeId: 'ChIJbanff', text: { text: 'Banff, AB, Canada' }, structuredFormat: { mainText: { text: 'Banff' }, secondaryText: { text: 'AB, Canada' } } } },
            { queryPrediction: { text: { text: 'banff hotels' } } },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const s = await new PlaceSearchProvider('k').suggest('Banff', { session: 'abcdef123456', near: { lat: 43.65, lng: -79.38 } });
    expect(s).toEqual([{ placeId: 'ChIJbanff', title: 'Banff', subtitle: 'AB, Canada', address: 'Banff, AB, Canada' }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ input: 'Banff', sessionToken: 'abcdef123456' });
    expect(body.locationBias.circle.center).toEqual({ latitude: 43.65, longitude: -79.38 });
  });

  it('gets the picked place with Essentials fields only, closing the session', async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'ChIJbanff',
          formattedAddress: 'Banff, AB T1L, Canada',
          location: { latitude: 51.178, longitude: -115.57 },
          addressComponents: [
            { longText: 'Alberta', shortText: 'AB', types: ['administrative_area_level_1'] },
            { longText: 'Canada', shortText: 'CA', types: ['country'] },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const d = await new PlaceSearchProvider('k').details('ChIJbanff', 'abcdef123456');
    expect(d).toEqual({ placeId: 'ChIJbanff', address: 'Banff, AB T1L, Canada', location: { lat: 51.178, lng: -115.57 }, country: 'CA', region: 'AB' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places/ChIJbanff?sessionToken=abcdef123456');
    expect((init.headers as Record<string, string>)['x-goog-fieldmask']).not.toContain('displayName');
  });
});

describe('Google Routes request', () => {
  it('never sends a departure time with traffic-unaware routing (Google returns 400)', async () => {
    const { RoutesProvider } = await import('./google.js');
    const { ProviderContext } = await import('./infra.js');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ routes: [{ distanceMeters: 1000, duration: '60s', polyline: { encodedPolyline: '' } }] })));
    vi.stubGlobal('fetch', fetch);
    await new RoutesProvider('k').compute(
      { origin: { lat: 43.65, lng: -79.38 }, destination: { lat: 43.25, lng: -79.87 }, waypoints: [], departureIso: '2099-01-01T09:00:00-05:00', alternatives: false },
      new ProviderContext(),
    );
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.routingPreference).toBe('TRAFFIC_UNAWARE');
    expect(body).not.toHaveProperty('departureTime');
  });
});

describe('suggestion bias', () => {
  it('falls back to North America rather than the server location', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ suggestions: [] })));
    vi.stubGlobal('fetch', fetch);
    await new PlaceSearchProvider('k').suggest('Banf');
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.locationBias.rectangle).toBeDefined();
  });

  it('reads the visitor location from Vercel headers', async () => {
    const { visitorLocation } = await import('../places/places.controller.js');
    expect(visitorLocation({ 'x-vercel-ip-latitude': '43.65', 'x-vercel-ip-longitude': '-79.38' })).toEqual({ lat: 43.65, lng: -79.38 });
    expect(visitorLocation({})).toBeUndefined();
    expect(visitorLocation({ 'x-vercel-ip-latitude': 'x', 'x-vercel-ip-longitude': '1' })).toBeUndefined();
  });
});

describe('travel places only', () => {
  it('drops clinics and shops when there are real places to show', async () => {
    const pred = (placeId: string, title: string, types: string[]) => ({ placePrediction: { placeId, text: { text: title }, structuredFormat: { mainText: { text: title } }, types } });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ suggestions: [pred('a', 'Banff', ['locality', 'political', 'geocode']), pred('b', 'Banfield Pet Hospital', ['veterinary_care', 'point_of_interest', 'establishment']), pred('c', 'Banff Gondola', ['tourist_attraction', 'point_of_interest'])] })),
    ));
    expect((await new PlaceSearchProvider('k').suggest('Banf')).map((s) => s.title)).toEqual(['Banff', 'Banff Gondola']);
  });
});
