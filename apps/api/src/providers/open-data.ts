import { decodePolyline, haversineMeters, bbox, type LatLng, type RoadEvent, type TravelAdvisory } from '@rtp/core';
import { fetchJson, nowIso, ProviderContext, TtlCache } from './infra.js';

// ---------------- Ontario 511 road events ----------------

interface On511Event {
  ID: number | string;
  RoadwayName: string;
  Description: string;
  EventType: string;
  IsFullClosure: boolean;
  Severity?: string;
  Latitude: number;
  Longitude: number;
  LastUpdated?: number;
}

/** Ontario 511 (provincial highways). Needs a free developer key; limit 10 calls/minute, so events are cached. */
export class Ontario511Provider {
  private cache = new TtlCache<On511Event[]>(5 * 60_000);
  constructor(private readonly key?: string) {}

  async eventsNearRoute(polyline: string, ctx: ProviderContext, maxDistanceMeters = 1500): Promise<RoadEvent[]> {
    if (!this.key) {
      ctx.note('Road closures not checked: add ONTARIO_511_API_KEY (free from 511on.ca).');
      return [];
    }
    const events = await this.cache.get('events', () =>
      fetchJson<On511Event[]>('Ontario 511', `https://511on.ca/api/v2/get/event?format=json&lang=en&key=${this.key}`),
    );
    const pts = decodePolyline(polyline);
    const [minLng, minLat, maxLng, maxLat] = bbox(pts, 0.05);
    const sampled = pts.filter((_, i) => i % 3 === 0);
    const relevant = events.filter(
      (e) =>
        e.Latitude >= minLat &&
        e.Latitude <= maxLat &&
        e.Longitude >= minLng &&
        e.Longitude <= maxLng &&
        (e.IsFullClosure || /major|high/i.test(e.Severity ?? '')),
    );
    const near: RoadEvent[] = [];
    for (const e of relevant) {
      const p: LatLng = { lat: e.Latitude, lng: e.Longitude };
      if (sampled.some((q) => haversineMeters(p, q) <= maxDistanceMeters)) {
        near.push({
          id: `on511-${e.ID}`,
          road: e.RoadwayName,
          description: e.Description,
          type: e.EventType,
          fullClosure: !!e.IsFullClosure,
          location: p,
          updatedAt: e.LastUpdated ? new Date(e.LastUpdated * 1000).toISOString() : undefined,
          source: { name: 'Ontario 511', url: 'https://511on.ca', retrievedAt: nowIso() },
        });
      }
    }
    return near.slice(0, 20);
  }
}

// ---------------- Global Affairs Canada travel advisories ----------------

interface GacEntry {
  'country-iso': string;
  'country-eng': string;
  'advisory-state': number;
  'date-published': { date: string };
  eng: { name: string; 'url-slug': string; 'advisory-text': string };
}

/** Official Government of Canada advice for Canadians abroad (open data, updated continually). */
export class AdvisoryProvider {
  private cache = new TtlCache<Record<string, GacEntry>>(60 * 60_000);

  async forCountries(isoCodes: string[]): Promise<TravelAdvisory[]> {
    const wanted = [...new Set(isoCodes.filter((c) => c && c !== 'CA'))];
    if (!wanted.length) return [];
    const data = await this.cache.get('all', async () => {
      const res = await fetchJson<{ data: Record<string, GacEntry> }>(
        'Global Affairs Canada',
        'https://data.international.gc.ca/travel-voyage/index-alpha-eng.json',
      );
      return res.data;
    });
    return wanted
      .map((c) => data[c])
      .filter(Boolean)
      .map((e) => ({
        countryCode: e['country-iso'],
        country: e.eng.name,
        level: e['advisory-state'],
        text: e.eng['advisory-text'],
        updatedAt: e['date-published'].date,
        url: `https://travel.gc.ca/destinations/${e.eng['url-slug']}`,
        issuedBy: 'Government of Canada (Global Affairs Canada)',
      }));
  }
}
