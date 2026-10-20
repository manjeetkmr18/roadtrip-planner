import type { LatLng, PlaceSuggestion } from '../core/index.js';
import { fetchJson } from './infra.js';
import { SAMPLE_PLACES } from './sample-data.js';
import { worldCities } from './airports.js';

const BASE = 'https://places.googleapis.com/v1';

interface AutocompleteResponse {
  suggestions?: {
    placePrediction?: {
      placeId: string;
      text?: { text: string };
      structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } };
      types?: string[];
    };
  }[];
}

interface DetailsResponse {
  id: string;
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  addressComponents?: { longText: string; shortText: string; types: string[] }[];
}

export interface PickedPlace {
  placeId?: string;
  address: string;
  location: LatLng;
  country?: string;
  region?: string;
}

/**
 * Places a trip can start, end or stop at: towns, regions and addresses ("geocode" covers all of
 * those), plus parks, sights, airports, places to stay and eat. Keeps clinics, shops and offices
 * out of the list ("Banf" → Banff, not Banfield Pet Hospital).
 */
const TRAVEL_TYPES = new Set([
  'geocode', 'tourist_attraction', 'park', 'national_park', 'state_park', 'natural_feature', 'beach', 'hiking_area', 'campground', 'rv_park',
  'museum', 'art_gallery', 'historical_landmark', 'historical_place', 'monument', 'church', 'zoo', 'aquarium', 'amusement_park', 'ski_resort',
  'marina', 'ferry_terminal', 'airport', 'train_station', 'bus_station', 'transit_station', 'stadium', 'event_venue', 'visitor_center',
  'lodging', 'hotel', 'motel', 'resort_hotel', 'restaurant', 'cafe', 'winery', 'brewery', 'shopping_mall', 'university', 'gas_station',
  'electric_vehicle_charging_station', 'parking',
]);
export const isTravelPlace = (types?: string[]) => !types?.length || types.some((t) => TRAVEL_TYPES.has(t));

/** Session tokens group a user's keystrokes and the final pick into one billed Google session. */
export const SESSION_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Type-ahead for the start, destination and stop fields (Google Places Autocomplete, New).
 * Each search session ends with `details`, so Google bills the keystrokes as one session.
 * Without a key it suggests from the built-in sample cities.
 */
export class PlaceSearchProvider {
  constructor(private readonly key?: string) {}

  get live() {
    return !!this.key;
  }

  async lodging(input: string, near: LatLng): Promise<PlaceSuggestion[]> {
    if (!this.key) throw new Error('Hotel search needs GOOGLE_MAPS_API_KEY');
    const query = input.trim() || 'lodging';
    const res = await fetchJson<{
      places?: {
        id: string;
        displayName?: { text: string };
        formattedAddress?: string;
        location?: { latitude: number; longitude: number };
      }[];
    }>('Google Places lodging search', `${BASE}/places:searchText`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.key,
        'x-goog-fieldmask': 'places.id,places.displayName,places.formattedAddress,places.location',
      },
      body: JSON.stringify({
        textQuery: query === 'lodging' ? 'hotels' : query,
        includedType: 'lodging',
        strictTypeFiltering: true,
        maxResultCount: 6,
        locationBias: {
          circle: {
            center: { latitude: near.lat, longitude: near.lng },
            radius: 50_000,
          },
        },
      }),
      timeoutMs: 6_000,
      retries: 0,
    });
    return (res.places ?? [])
      .filter((place) => place.id && place.displayName?.text && place.location && place.formattedAddress)
      .map((place) => ({
        placeId: place.id,
        title: place.displayName!.text,
        subtitle: place.formattedAddress!,
        address: place.formattedAddress!,
        location: { lat: place.location!.latitude, lng: place.location!.longitude },
      }));
  }

  async suggest(input: string, opts: { session?: string; near?: LatLng } = {}): Promise<PlaceSuggestion[]> {
    const q = input.trim();
    if (q.length < 2) return [];
    if (!this.key) return sampleSuggestions(q);

    const res = await fetchJson<AutocompleteResponse>('Google Places Autocomplete', `${BASE}/places:autocomplete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key },
      body: JSON.stringify({
        input: q,
        ...(opts.session ? { sessionToken: opts.session } : {}),
        // Nudge results toward the trip's area (or the user's) without excluding anywhere else.
        // With no hint at all Google would bias toward the server's own location (a US data
        // centre), so fall back to North America.
        locationBias: opts.near
          ? { circle: { center: { latitude: opts.near.lat, longitude: opts.near.lng }, radius: 50_000 } }
          : { rectangle: { low: { latitude: 24, longitude: -141 }, high: { latitude: 70, longitude: -52 } } },
      }),
      timeoutMs: 6_000,
      retries: 0,
    });
    return (res.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
      .filter((p, _i, all) => isTravelPlace(p.types) || !all.some((x) => isTravelPlace(x.types)))
      .slice(0, 6)
      .map((p) => {
        const title = p.structuredFormat?.mainText?.text ?? p.text?.text ?? '';
        const subtitle = p.structuredFormat?.secondaryText?.text;
        return { placeId: p.placeId, title, subtitle, address: p.text?.text ?? [title, subtitle].filter(Boolean).join(', ') };
      });
  }

  /** Where the picked suggestion is. Only Essentials fields, to keep the per-pick cost low. */
  async details(placeId: string, session?: string): Promise<PickedPlace> {
    if (!this.key) throw new Error('Place details need GOOGLE_MAPS_API_KEY');
    const url = `${BASE}/places/${encodeURIComponent(placeId)}${session ? `?sessionToken=${encodeURIComponent(session)}` : ''}`;
    const r = await fetchJson<DetailsResponse>('Google Place Details', url, {
      headers: { 'x-goog-api-key': this.key, 'x-goog-fieldmask': 'id,formattedAddress,location,addressComponents' },
      timeoutMs: 6_000,
      retries: 0,
    });
    if (!r.location) throw new Error('Google returned no location for this place');
    const comp = (t: string) => r.addressComponents?.find((c) => c.types.includes(t));
    return {
      placeId: r.id,
      address: r.formattedAddress ?? placeId,
      location: { lat: r.location.latitude, lng: r.location.longitude },
      country: comp('country')?.shortText,
      region: comp('administrative_area_level_1')?.shortText,
    };
  }
}

/** Sample mode: prefix matches on the built-in city lists, with coordinates so no details call is needed. */
export function sampleSuggestions(q: string): PlaceSuggestion[] {
  const s = q.toLowerCase().split(',')[0].trim();
  const out: PlaceSuggestion[] = [];
  for (const p of SAMPLE_PLACES) {
    if (p.name.toLowerCase().startsWith(s)) out.push({ title: p.name, subtitle: `${p.region}, ${p.country === 'CA' ? 'Canada' : 'USA'}`, address: `${p.name}, ${p.region}`, location: p.location });
  }
  for (const c of worldCities()) {
    if (c.city.toLowerCase().startsWith(s) && !out.some((o) => o.title === c.city)) out.push({ title: c.city, subtitle: c.country, address: `${c.city}, ${c.country}`, location: c.location });
  }
  return out.slice(0, 6);
}
