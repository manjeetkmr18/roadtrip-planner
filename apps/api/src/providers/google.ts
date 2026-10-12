import {
  decodePolyline,
  encodePolyline,
  haversineMeters,
  pointAlong,
  samplePoints,
  ETR407_EAST_END_LNG,
  ETR407_WEST_END_LNG,
  type LatLng,
  type OpeningPeriod,
  type PlaceInput,
  type RouteStep,
  type FuelType,
} from '@rtp/core';
import { fetchJson, nowIso, ProviderContext } from './infra.js';
import { findSamplePlace, nearestSamplePlace } from './sample-data.js';

// ---------------- Geocoding ----------------

export interface ResolvedPlace {
  label: string;
  location: LatLng;
  country?: string; // ISO-2
  region?: string; // province / state code
  placeId?: string;
  urban?: boolean;
}

interface GeocodeResponse {
  status: string;
  results: {
    formatted_address: string;
    place_id: string;
    geometry: { location: LatLng };
    address_components: { short_name: string; long_name: string; types: string[] }[];
  }[];
}

export class GeocodingProvider {
  constructor(private readonly key?: string) {}

  private fromResult(r: GeocodeResponse['results'][number]): ResolvedPlace {
    const comp = (type: string) => r.address_components.find((c) => c.types.includes(type));
    const locality = comp('locality')?.long_name ?? comp('administrative_area_level_2')?.long_name;
    const region = comp('administrative_area_level_1')?.short_name;
    return {
      label: locality && region ? `${locality}, ${region}` : r.formatted_address,
      location: r.geometry.location,
      country: comp('country')?.short_name,
      region,
      placeId: r.place_id,
      urban: true,
    };
  }

  async resolve(input: PlaceInput, ctx: ProviderContext): Promise<ResolvedPlace> {
    if (!this.key) {
      const s = findSamplePlace(input.address) ?? (input.location ? nearestSamplePlace(input.location) : undefined);
      if (!s) throw new Error(`Sample mode only knows major Canadian/US cities; could not place "${input.address}". Add GOOGLE_MAPS_API_KEY.`);
      ctx.sample('Locations use a built-in sample city list (no GOOGLE_MAPS_API_KEY).');
      return { label: `${s.name}, ${s.region}`, location: input.location ?? s.location, country: s.country, region: s.region, urban: s.urban };
    }
    const q = input.placeId ? `place_id=${encodeURIComponent(input.placeId)}` : `address=${encodeURIComponent(input.address)}`;
    const res = await fetchJson<GeocodeResponse>('Google Geocoding', `https://maps.googleapis.com/maps/api/geocode/json?${q}&key=${this.key}`);
    ctx.record('geocoding');
    if (res.status !== 'OK' || !res.results.length) throw new Error(`Could not find "${input.address}" (${res.status})`);
    const r = this.fromResult(res.results[0]);
    return input.location ? { ...r, location: input.location } : r;
  }

  /** Nearest town name for an overnight point. */
  async reverse(p: LatLng, ctx: ProviderContext): Promise<ResolvedPlace> {
    if (!this.key) {
      const s = nearestSamplePlace(p);
      ctx.sample('Locations use a built-in sample city list (no GOOGLE_MAPS_API_KEY).');
      const d = haversineMeters(p, s.location);
      return {
        label: d < 40_000 ? `${s.name}, ${s.region}` : `near ${s.name}, ${s.region}`,
        location: p,
        country: s.country,
        region: s.region,
        urban: s.urban && d < 15_000,
      };
    }
    const res = await fetchJson<GeocodeResponse>(
      'Google Geocoding',
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${p.lat},${p.lng}&result_type=locality|administrative_area_level_3&key=${this.key}`,
    );
    ctx.record('geocoding');
    if (!res.results.length) return { label: `${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}`, location: p };
    return { ...this.fromResult(res.results[0]), location: p };
  }
}

// ---------------- Routes ----------------

export interface RawRoute {
  distanceMeters: number;
  durationSeconds: number;
  polyline: string;
  steps: RouteStep[];
  /** null = provider reports no tolls; known=false = tolls exist but unpriced. */
  toll: { known: boolean; prices: { currency: string; amount: number }[] } | null;
  description?: string;
  sample: boolean;
}

export interface RouteQuery {
  origin: LatLng;
  destination: LatLng;
  waypoints: LatLng[];
  departureIso: string;
  avoidTolls: boolean;
  alternatives: boolean;
  tollPasses: string[];
  fuelType: FuelType;
}

interface GoogleRoutesResponse {
  routes?: {
    distanceMeters?: number;
    duration?: string;
    description?: string;
    polyline?: { encodedPolyline: string };
    travelAdvisory?: { tollInfo?: { estimatedPrice?: { currencyCode: string; units?: string; nanos?: number }[] } };
    legs?: {
      steps?: {
        distanceMeters?: number;
        staticDuration?: string;
        polyline?: { encodedPolyline: string };
        startLocation?: { latLng: { latitude: number; longitude: number } };
        endLocation?: { latLng: { latitude: number; longitude: number } };
        navigationInstruction?: { instructions?: string };
      }[];
    }[];
  }[];
}

const secs = (d?: string) => (d ? Number(d.replace('s', '')) : 0);
const ll = (p?: { latLng: { latitude: number; longitude: number } }) => (p ? { lat: p.latLng.latitude, lng: p.latLng.longitude } : undefined);

const EMISSION: Record<FuelType, string> = { gasoline: 'GASOLINE', diesel: 'DIESEL', hybrid: 'HYBRID', electric: 'ELECTRIC' };

export class RoutesProvider {
  constructor(private readonly key?: string) {}

  async compute(q: RouteQuery, ctx: ProviderContext): Promise<RawRoute[]> {
    if (!this.key) return [this.sampleRoute(q, ctx)];
    const wp = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const body = {
      origin: wp(q.origin),
      destination: wp(q.destination),
      intermediates: q.waypoints.map(wp),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
      departureTime: Date.parse(q.departureIso) > Date.now() ? q.departureIso : undefined,
      computeAlternativeRoutes: q.alternatives && q.waypoints.length === 0,
      extraComputations: ['TOLLS'],
      routeModifiers: {
        avoidTolls: q.avoidTolls,
        vehicleInfo: { emissionType: EMISSION[q.fuelType] },
        tollPasses: q.tollPasses.length ? q.tollPasses : undefined,
      },
      languageCode: 'en-CA',
      units: 'METRIC',
    };
    const fieldMask = [
      'routes.distanceMeters',
      'routes.duration',
      'routes.description',
      'routes.polyline.encodedPolyline',
      'routes.travelAdvisory.tollInfo',
      'routes.legs.steps.distanceMeters',
      'routes.legs.steps.staticDuration',
      'routes.legs.steps.polyline.encodedPolyline',
      'routes.legs.steps.startLocation',
      'routes.legs.steps.endLocation',
      'routes.legs.steps.navigationInstruction.instructions',
    ].join(',');
    const res = await fetchJson<GoogleRoutesResponse>('Google Routes', 'https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify(body),
      timeoutMs: 25_000,
    });
    ctx.record('routesWithTolls');
    return (res.routes ?? []).map((r) => {
      const tollInfo = r.travelAdvisory?.tollInfo;
      const prices = (tollInfo?.estimatedPrice ?? []).map((p) => ({
        currency: p.currencyCode,
        amount: Number(p.units ?? 0) + (p.nanos ?? 0) / 1e9,
      }));
      return {
        distanceMeters: r.distanceMeters ?? 0,
        durationSeconds: secs(r.duration),
        polyline: r.polyline?.encodedPolyline ?? '',
        description: r.description,
        steps: (r.legs ?? []).flatMap((leg) =>
          (leg.steps ?? []).map((s) => ({
            distanceMeters: s.distanceMeters ?? 0,
            durationSeconds: secs(s.staticDuration),
            instruction: s.navigationInstruction?.instructions,
            polyline: s.polyline?.encodedPolyline,
            startLocation: ll(s.startLocation),
            endLocation: ll(s.endLocation),
            roads: [],
          })),
        ),
        toll: tollInfo ? { known: prices.length > 0, prices } : null,
        sample: false,
      };
    });
  }

  /**
   * Sample route: straight segments through the waypoints with a road-distance factor,
   * cut into ~50 km steps. Steps through the GTA 407 corridor are labelled "Highway 407"
   * so the 407 calculator can be exercised without a key.
   */
  private sampleRoute(q: RouteQuery, ctx: ProviderContext): RawRoute {
    ctx.sample('Routes are approximate sample geometry (no GOOGLE_MAPS_API_KEY).');
    const pts = [q.origin, ...q.waypoints, q.destination];
    const dense: LatLng[] = [];
    for (let i = 1; i < pts.length; i++) {
      const d = haversineMeters(pts[i - 1], pts[i]);
      const n = Math.max(2, Math.ceil(d / 10_000));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        const t = k / n;
        dense.push({ lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t, lng: pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * t });
      }
    }
    const roadFactor = 1.25;
    const kmh = q.avoidTolls ? 88 : 95;
    const steps: RouteStep[] = [];
    let i = 0;
    while (i < dense.length - 1) {
      const chunk = [dense[i]];
      let d = 0;
      let j = i;
      while (j < dense.length - 1 && d < 50_000) {
        d += haversineMeters(dense[j], dense[j + 1]) * roadFactor;
        chunk.push(dense[++j]);
      }
      const mid = chunk[Math.floor(chunk.length / 2)];
      const in407 = !q.avoidTolls && mid.lat > 43.55 && mid.lat < 43.95 && mid.lng > ETR407_WEST_END_LNG && mid.lng < ETR407_EAST_END_LNG;
      steps.push({
        distanceMeters: Math.round(d),
        durationSeconds: Math.round((d / 1000 / kmh) * 3600),
        instruction: in407 ? 'Continue on Highway 407 ETR (sample)' : 'Continue on highway (sample route)',
        polyline: encodePolyline(chunk),
        startLocation: chunk[0],
        endLocation: chunk[chunk.length - 1],
        roads: in407 ? ['407'] : [],
      });
      i = j;
    }
    return {
      distanceMeters: steps.reduce((s, x) => s + x.distanceMeters, 0),
      durationSeconds: steps.reduce((s, x) => s + x.durationSeconds, 0),
      polyline: encodePolyline(dense),
      steps,
      toll: null,
      description: q.avoidTolls ? 'Sample route avoiding tolls' : 'Sample route',
      sample: true,
    };
  }
}

// ---------------- Places ----------------

export interface CandidatePlace {
  id: string;
  name: string;
  location: LatLng;
  address?: string;
  rating?: number;
  ratingCount?: number;
  types: string[];
  openingHours?: OpeningPeriod[];
  mapsUrl?: string;
  query: string;
  sample: boolean;
}

interface PlacesResponse {
  places?: {
    id: string;
    displayName?: { text: string };
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
    rating?: number;
    userRatingCount?: number;
    types?: string[];
    googleMapsUri?: string;
    regularOpeningHours?: {
      periods?: { open: { day: number; hour: number; minute: number }; close?: { day: number; hour: number; minute: number } }[];
    };
  }[];
}

const hm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

export function toOpeningPeriods(periods?: NonNullable<NonNullable<PlacesResponse['places']>[number]['regularOpeningHours']>['periods']): OpeningPeriod[] | undefined {
  if (!periods || periods.length === 0) return undefined;
  // Always open: a single period with no close.
  if (periods.length === 1 && !periods[0].close) {
    return [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '23:59' }));
  }
  return periods
    .filter((p) => p.close)
    .map((p) => ({ day: p.open.day, open: hm(p.open.hour, p.open.minute), close: hm(p.close!.hour, p.close!.minute) }));
}

export class PlacesProvider {
  constructor(private readonly key?: string) {}

  private static readonly FIELDS = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.location',
    'places.rating',
    'places.userRatingCount',
    'places.types',
    'places.googleMapsUri',
    'places.regularOpeningHours.periods',
  ].join(',');

  private async search(body: object, query: string, ctx: ProviderContext): Promise<CandidatePlace[]> {
    const res = await fetchJson<PlacesResponse>('Google Places', 'https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.key!, 'X-Goog-FieldMask': PlacesProvider.FIELDS },
      body: JSON.stringify(body),
    });
    ctx.record('placesTextSearchEnterprise');
    return (res.places ?? [])
      .filter((p) => p.location && p.displayName)
      .map((p) => ({
        id: p.id,
        name: p.displayName!.text,
        location: { lat: p.location!.latitude, lng: p.location!.longitude },
        address: p.formattedAddress,
        rating: p.rating,
        ratingCount: p.userRatingCount,
        types: p.types ?? [],
        openingHours: toOpeningPeriods(p.regularOpeningHours?.periods),
        mapsUrl: p.googleMapsUri,
        query,
        sample: false,
      }));
  }

  async alongRoute(query: string, polyline: string, max: number, ctx: ProviderContext): Promise<CandidatePlace[]> {
    if (!this.key) return this.sample(query, decodePolyline(polyline), max, ctx);
    return this.search({ textQuery: query, maxResultCount: max, searchAlongRouteParameters: { polyline: { encodedPolyline: polyline } } }, query, ctx);
  }

  async near(query: string, center: LatLng, radiusMeters: number, max: number, ctx: ProviderContext): Promise<CandidatePlace[]> {
    if (!this.key) return this.sample(query, [center, { lat: center.lat + 0.05, lng: center.lng + 0.08 }], max, ctx);
    return this.search(
      { textQuery: query, maxResultCount: max, locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: Math.min(50_000, radiusMeters) } } },
      query,
      ctx,
    );
  }

  private sample(query: string, line: LatLng[], max: number, ctx: ProviderContext): CandidatePlace[] {
    ctx.sample('Stops are placeholders (no GOOGLE_MAPS_API_KEY); real attractions come from Google Places.');
    return samplePoints(line, Math.min(max, 4)).map((p, i) => {
      const town = nearestSamplePlace(p);
      const loc = pointAlong([p, { lat: p.lat + 0.02, lng: p.lng + 0.02 }], 0.5);
      return {
        id: `sample-${query.replace(/\W+/g, '-')}-${i}-${town.name.replace(/\W+/g, '')}`,
        name: `Sample ${query} near ${town.name}`,
        location: loc,
        rating: 4.2 + (i % 3) / 10,
        ratingCount: 500 + i * 250,
        types: ['tourist_attraction'],
        openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '09:00', close: '17:00' })),
        query,
        sample: true,
      };
    });
  }
}

export const nowSource = (name: string, url?: string) => ({ name, url, retrievedAt: nowIso() });
