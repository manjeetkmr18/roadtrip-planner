import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaceSearchProvider, sampleSuggestions } from './place-search.js';

afterEach(() => vi.unstubAllGlobals());

describe('place suggestions', () => {
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
